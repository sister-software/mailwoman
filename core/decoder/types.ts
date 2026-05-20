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
 *   Phase 4.1 added optional `source` / `sourceId` on `AddressNode` so the XML serializer can emit
 *   provenance via `src="<source>:<sourceId>"`. The neural pipeline stamps these via
 *   `BuildTreeOpts`; the proposal-derived path threads them through from `ClassificationProposal`.
 *   JSON / tuple projections deliberately do not surface provenance — libpostal compat is
 *   load-bearing.
 */

import type { BioLabel, ComponentTag } from "../types/component.js"

export type { BioLabel, ComponentTag }

/**
 * A single token emitted by the model, paired with its predicted label and confidence.
 *
 * `start`/`end` are character offsets into the original raw input. The tokenizer is responsible for
 * producing these (SentencePiece's `encode` returns offsets); they are NOT recomputed by the
 * decoder.
 */
export interface DecoderToken {
	/** The token piece as the tokenizer emitted it (with any leading-space sentinel preserved). */
	piece: string
	/** Inclusive start char offset in the original raw text. */
	start: number
	/** Exclusive end char offset in the original raw text. */
	end: number
	/** The argmax BIO label for this token. */
	label: BioLabel
	/** Softmax confidence for the chosen label, in [0, 1]. */
	confidence: number
}

/**
 * One node of the address tree — a component span plus any nested child components.
 *
 * `value` is the raw text covered by this span, sliced from the original input by `[start, end)`.
 * `confidence` is aggregated across the span's tokens (currently mean; see `build-tree.ts`).
 * `children` are tagged subcomponents whose spans fall within this node's span AND whose tag's
 * containment rule names this node's tag as a permitted parent.
 */
export interface AddressNode {
	tag: ComponentTag
	value: string
	start: number
	end: number
	confidence: number
	children: AddressNode[]
	/**
	 * Broad category of the assertion's origin. `"rule"` and `"neural"` come from classifier
	 * proposals; `"resolver"` will be added in Phase 4.3 when a resolver overwrites the attribution.
	 */
	source?: string
	/**
	 * Specific identifier within `source`: a rule classifier id like `"whos_on_first"`, a neural
	 * model card version like `"neural-v0.3.1-en-us"`, or (Phase 4.3) a resolver place id like
	 * `"wof-admin:101751113"`.
	 */
	sourceId?: string
}

/**
 * The full decoded tree for one parsed address.
 *
 * `roots` is the list of top-level components in source order. Components that don't have a
 * containing parent in the labeled output become roots themselves (e.g. a bare "house_number" with
 * no labeled street parent).
 */
export interface AddressTree {
	/** The original raw input text — preserved for round-trip and XML root @raw attribute. */
	raw: string
	roots: AddressNode[]
}
