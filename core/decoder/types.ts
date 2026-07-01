/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Output-shape types for the neural classifier decoder.
 *
 *   The decoder turns a flat stream of BIO-labeled tokens (the raw output of the sequence model) into
 *   an `AddressTree` — a containment-nested representation that downstream code projects into JSON
 *   (libpostal-compat), tuple pairs (order-preserving), or XML (hierarchy + attributes).
 *
 *   Why three shapes:
 *
 *   - JSON is the libpostal-compat surface; downstream users with existing pipelines.
 *   - Tuples preserve repetition + source order — fixes the lossy cases JSON can't handle.
 *   - XML preserves containment hierarchy and per-node attributes (conf today, src in Phase 4 when the
 *       Resolver lands). XML chosen over S-expression for LLM-tooling alignment and off-the-shelf
 *       parser availability.
 *
 *   See `containment.ts` for the parent-of mapping that drives nesting.
 *
 *   Phase 4.1 added optional `source` / `sourceID` on `AddressNode` so the XML serializer can emit
 *   provenance via `src="<source>:<sourceID>"`. The neural pipeline stamps these via
 *   `BuildTreeOpts`; the proposal-derived path threads them through from `ClassificationProposal`.
 *   JSON / tuple projections deliberately do not surface provenance — libpostal compat is
 *   essential.
 */

import type { BIOLabel, ComponentTag } from "../types/component.js"

export type { BIOLabel, ComponentTag }

/**
 * A single token emitted by the model, paired with its predicted label and confidence.
 *
 * `start`/`end` are character offsets into the original raw input. The tokenizer is responsible for producing these
 * (SentencePiece's `encode` returns offsets); they are NOT recomputed by the decoder.
 */
export interface DecoderToken {
	/** The token piece as the tokenizer emitted it (with any leading-space sentinel preserved). */
	piece: string
	/** Inclusive start char offset in the original raw text. */
	start: number
	/** Exclusive end char offset in the original raw text. */
	end: number
	/** The argmax BIO label for this token. */
	label: BIOLabel
	/** Softmax confidence for the chosen label, in [0, 1]. */
	confidence: number
}

/**
 * One node of the address tree — a component span plus any nested child components.
 *
 * `value` is the raw text covered by this span, sliced from the original input by `[start, end)`. `confidence` is
 * aggregated across the span's tokens (currently mean; see `build-tree.ts`). `children` are tagged subcomponents whose
 * spans fall within this node's span AND whose tag's containment rule names this node's tag as a permitted parent.
 */
export interface AddressNode {
	tag: ComponentTag
	value: string
	start: number
	end: number
	confidence: number
	children: AddressNode[]
	/**
	 * Broad category of the assertion's origin. `"rule"` and `"neural"` come from classifier proposals; `"resolver"` is
	 * set by Phase 4.3's resolver when it overwrites the classifier attribution (the displaced classifier source lands in
	 * `metadata.classifier_source`).
	 */
	source?: string
	/**
	 * Specific identifier within `source`: a rule classifier id like `"whos_on_first"`, a neural model card version like
	 * `"neural-v0.3.1-en-us"`, or a resolver-supplied place id like `"wof-admin:101751119"`.
	 */
	sourceID?: string
	/** Resolver-supplied centroid latitude (Phase 4.3). Optional — only set when a resolver wins. */
	lat?: number
	/** Resolver-supplied centroid longitude (Phase 4.3). Optional — only set when a resolver wins. */
	lon?: number
	/**
	 * Resolver-supplied normalized place URI (Phase 4.3) — `"wof:101751119"` for a WOF place. Distinct from `sourceID`
	 * (which includes the resolver vendor) so consumers that want the canonical place id without the vendor prefix have
	 * one.
	 */
	placeID?: string
	/**
	 * Opaque per-node metadata bag. Phase 4.3 uses keys `classifier_source` and `classifier_source_id` to preserve the
	 * displaced classifier attribution when a resolver wins. Never consulted by the decoder or serializers — debugging +
	 * downstream telemetry only.
	 */
	metadata?: Record<string, unknown>
	/**
	 * Top-k alternative resolutions for this node, ranked by score (highest first). The winning candidate is reflected in
	 * `placeID` / `lat` / `lon` / `sourceID`. Surfaced for failure mode #8 (Springfield-class ambiguity) — callers
	 * needing disambiguation see the runners-up. Empty / absent when the resolver returned a single candidate.
	 *
	 * Typed as `unknown[]` here to avoid a circular import on `ResolvedPlace`; resolver-emitting code sets the concrete
	 * shape, consumers may cast to `ResolvedPlace[]` from `@mailwoman/core/resolver`.
	 */
	alternatives?: ReadonlyArray<unknown>
	/**
	 * ADDITIONAL roles this single span plays, beyond `tag` (#413). A place can hold multiple admin tiers under one name
	 * — a city-state (Berlin is region AND locality) or a capital-seat province (Milano province ~ Milano comune). Rather
	 * than synthesize a second node with a borrowed span, the resolver records the extra role(s) here, so one node = one
	 * span = many roles (the model Google's `address_components[].types` uses). `tag`/`placeID`/`lat`/`lon` remain the
	 * PRIMARY role; each interpretation is a distinct secondary role with its own resolved place. Serializers surface
	 * every role (a city-state emits both `region` and `locality`). Distinct from `alternatives` — those are same-role
	 * runner-up places (Springfield IL vs MA); interpretations are DIFFERENT tags, same span. Empty / absent for the
	 * common single-role node. Both completion (#415) and a future concordance decode write into this one slot.
	 */
	interpretations?: ReadonlyArray<Interpretation>
}

/** One additional role a span plays (#413) — see {@link AddressNode.interpretations}. */
export interface Interpretation {
	tag: ComponentTag
	/** Resolver-supplied normalized place URI for this role (e.g. `wof:101909779`). */
	placeID?: string
	sourceID?: string
	/** Centroid for this role's place (a capital-seat comune differs from its province). */
	lat?: number
	lon?: number
	confidence?: number
	metadata?: Record<string, unknown>
}

/**
 * The full decoded tree for one parsed address.
 *
 * `roots` is the list of top-level components in source order. Components that don't have a containing parent in the
 * labeled output become roots themselves (e.g. a bare "house_number" with no labeled street parent).
 */
export interface AddressTree {
	/** The original raw input text — preserved for round-trip and XML root @raw attribute. */
	raw: string
	roots: AddressNode[]
	/**
	 * The addressing SYSTEM this tree was decoded under, which selects the containment hierarchy
	 * (`containmentFor(system)` in `./containment.ts`). Absent means the default Western hierarchy (`house_number →
	 * street → locality → …`).
	 *
	 * This is forward-compat insurance, not yet a behavioral switch: every system currently resolves to the same map, so
	 * an absent or present `system` produces identical trees today. It exists so that when a distinct system lands (e.g.
	 * Japanese block addressing, where `building_number` nests under `sub_block`/`block` with no `street` parent),
	 * consumers and the tree builder already carry the discriminator — no `AddressTree` shape change later. A locale
	 * pre-classifier (Phase 6+) is the intended source of this value.
	 */
	system?: AddressSystem
}

/**
 * The addressing system a tree was decoded under — selects the containment hierarchy. Western covers
 * US/EU/most-Latin-script street addressing (`house_number → street → locality`). `japanese` is declared for
 * forward-compat (block addressing: `building_number → sub_block → block → district`, no street); it currently shares
 * the Western map until Phase 6 gives it a distinct one. Open string union so a new system can be added without a
 * breaking enum change.
 */
export type AddressSystem = "western" | "japanese" | (string & {})
