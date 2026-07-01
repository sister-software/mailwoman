/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the runtime pipeline coordinator (`runPipeline`).
 *
 *   Generic over its stage implementations — each stage is an injected function or class, defined
 *   structurally. Keeps `@mailwoman/core` free of dependencies on the concrete neural / normalize /
 *   query-shape / resolver packages while still composing them at runtime when callers wire them
 *   up.
 *
 *   See `docs/articles/plan/reference/STAGES.md` for the full contract this implements.
 */

import type { AddressTree } from "../decoder/types.js"
import type { ResolveOpts, Resolver, ResolverBackend } from "../resolver/types.js"
import type { ClassificationProposal, Section } from "../types/classifier.js"

export type LocaleTag = string

/** Optional user-location signal for Stage 6 resolver scoring. */
export type UserLocation = { lat: number; lon: number } | { country: string } | { region: string; country: string }

/** Common opts threaded through every stage. */
export interface PipelineOpts {
	locale?: LocaleTag
	userLocation?: UserLocation
	/** Disable fast-path shortcuts; always run the full pipeline. */
	forceFullPipeline?: boolean
	/**
	 * The joint-reconcile path (Stage 5 beam search). Promoted to default by Route A Phase II (#427), then RETIRED AS
	 * DEFAULT 2026-06-14: a reconcile-vs-raw-neural audit found it breaks the street+house_number geocode precondition on
	 * 77-84% of clean US addresses (golden v0.1.2 US+FR, n=4507: street -25.6pp, house_number -23.1pp; worse-or-flat on
	 * every tag, venue included). The phrase grouper bundles the house number into the STREET_PHRASE and reconcileSpans
	 * fuses the span. The #427 "DE +25pp" gains were loose street-string recall on OOD inputs, not the geocode
	 * precondition. Default (unset) is now `false` (argmax). It still requires a phrase grouper + a classifier exposing
	 * `parseWithLogits`; when either is absent the pipeline uses argmax regardless.
	 *
	 * Set `jointReconcile: true` to opt back into reconcile (the A/B harnesses do). Report:
	 * docs/articles/evals/2026-06-14-reconcile-retirement.md.
	 */
	jointReconcile?: boolean
	/** @deprecated Use {@link jointReconcile}. Retained as an explicit override for the A/B harnesses. */
	forceJointReconcile?: boolean
	/** Hard cap on lookups the resolver may issue; passed through. */
	resolveOpts?: ResolveOpts
	/**
	 * Per-component rule-vs-neural arbitration (#478 increment 3). When `true` AND a `ruleProposer` stage is wired, the
	 * coordinator unions the whole-text neural parse with the solved v0 rule parse (as proposals), filters them
	 * per-component via the input-shape router prior, resolves span overlaps, and rebuilds the tree from the survivors.
	 * Default (unset) ⇒ `false` ⇒ the neural argmax tree is used unchanged (byte-stable). Behind a flag pending the
	 * assembled gate.
	 */
	arbitrate?: boolean
	/**
	 * #690: title-case detected all-caps ASCII input before the Stage 3 classifier (helps on all-caps registry/compliance
	 * data). Threaded to `ClassifierOpts.normalizeCase`. Detection-gated
	 *
	 * - Off by default → byte-stable for mixed-case input.
	 */
	normalizeCase?: boolean
	/**
	 * #743/#194: promote a CONFIDENT coarse-placer guess from the soft `anchorPosterior` boost to a HARD country filter
	 * (empty→unresolved) — see {@link ResolveOpts.hardCountry}. Gated three ways: the placer's confidence ≥
	 * `HARD_PLACE_COUNTRY_MIN_CONF` (ambiguous DK↔NO stay soft), the country is in the coverage
	 * `HARD_PLACE_COUNTRY_SAFELIST` (or a {@link hardCountrySafelist} override), and no caller
	 * `hardCountry`/`defaultCountry` is already set. **Default-ON** in the shipped
	 * `createRuntimePipeline`/`geocodeAddress` (#743, 2026-06-22) — but the safelist confines the hard filter to
	 * well-covered countries, so the low-coverage tail (FI/PL) keeps its recall on the soft path with no regression. Pass
	 * `false` to force the pre-#194 soft-only behavior.
	 */
	hardPlaceCountry?: boolean
	/**
	 * #743/#194: override the coverage safelist that gates {@link hardPlaceCountry}. Undefined → the built-in
	 * `HARD_PLACE_COUNTRY_SAFELIST` (production). Supply a set to test/measure a different coverage frontier — the
	 * resolver eval passes the full in-map country set to measure ungated hard-resolve-rates (which is how the production
	 * safelist is grown).
	 */
	hardCountrySafelist?: ReadonlySet<string>
	signal?: AbortSignal
}

/** Minimal structural shape `NormalizedInput` must satisfy. Compatible with @mailwoman/normalize. */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/** Minimal structural shape `QueryShape` must satisfy. Compatible with @mailwoman/query-shape. */
export interface QueryShapeLite {
	knownFormats: ReadonlyArray<{
		format: string
		span: { start: number; end: number }
		confidence: number
	}>
	segments?: ReadonlyArray<{ body: string; index: number }>
	characterClass?: string
	totalLength?: number
}

/** Detected (or asserted) locale + alternatives. */
export interface LocaleHint {
	locale: LocaleTag
	confidence: number
	alternatives: ReadonlyArray<{ locale: LocaleTag; confidence: number }>
	source: "caller" | "detected" | "ensemble"
}

/** Kind classifier output. */
export type QueryKind =
	| "postcode_only"
	| "locality_only"
	| "structured_address"
	| "intersection"
	| "po_box"
	| "landmark"
	| "vague"

export interface QueryKindResult {
	kind: QueryKind
	confidence: number
	alternatives: ReadonlyArray<{ kind: QueryKind; confidence: number }>
}

/**
 * Stage 2.7 phrase grouper output. Coarse phrase-shape hypothesis attached to a `Section` (sub-Span of the tokenized
 * input). The classifier (Stage 3) conditions on these proposals so it can answer the simpler "what type is this
 * proposed span?" instead of jointly discovering boundaries and types. The reconciler (Stage 5) consumes them as
 * boundary candidates for joint decoding.
 *
 * Taxonomy is purely structural — no place-name knowledge. A `LOCALITY_PHRASE` proposal is "this looks shaped like a
 * multi-word capitalized phrase that could be a city name" — not "this IS New York." Typing the span is the
 * classifier's job.
 *
 * See `docs/articles/concepts/the-knowledge-ladder.md` § Phrase grouper for the design rationale.
 */
export type PhraseKind =
	| "NUMERIC"
	| "STREET_PHRASE"
	| "LOCALITY_PHRASE"
	| "REGION_ABBREVIATION"
	| "POSTCODE"
	| "VENUE_PHRASE"
	| "HYPHENATED_COMPOUND"

/**
 * One phrase proposal emitted by Stage 2.7. The contract:
 *
 * - `span`: the input slice (sub-Span of the tokenized input) the proposal applies to.
 * - `kindHypothesis`: structural shape this slice looks like.
 * - `confidence`: 0..1 score. Used by downstream stages to weight proposals.
 *
 * Per "possibilities not constraints", emit a proposal whenever a rule fires — overlapping proposals over the same
 * tokens are expected (e.g. `Saint Petersburg` may surface as one `LOCALITY_PHRASE` AND two `LOCALITY_PHRASE`s, with
 * confidence ordering signalling which the grouper prefers).
 */
export interface PhraseProposal {
	span: Section
	kindHypothesis: PhraseKind
	confidence: number
}

/**
 * Stage 2.7 contract. Structural — any of the rule-based grouper (`@mailwoman/phrase-grouper`), a learned span proposer
 * (future), or a fake for tests satisfies this. Async so the coordinator can stay uniform even when implementations
 * call into models.
 */
export interface PhraseGrouper {
	group(input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint): Promise<PhraseProposal[]>
}

/**
 * Stage 3 contract: classifier that turns a text into an `AddressTree`. Structural — any of `@mailwoman/neural`'s
 * `NeuralAddressClassifier`, a rule-based classifier, or a fake for tests satisfies this.
 */
/**
 * Structural type for the FST gazetteer matcher, compatible with
 *
 * @mailwoman/core/resolver-wof-sqlite's FSTMatcher.
 */
export interface FSTMatcherLike {
	walk(tokens: string[]): { stateId: number; accepted: boolean; depth: number } | null
	walkFrom(
		prev: { stateId: number; depth: number },
		token: string
	): { stateId: number; accepted: boolean; depth: number } | null
	accepting(stateId: number): Array<{ wofID: number; placetype: string; importance: number }>
}

export interface ClassifierOpts {
	queryShape?: QueryShapeLite
	fst?: FSTMatcherLike
	fstBiasScale?: number
	/** Run the deterministic postcode regex repair pass (v0.7 #35) on the decoded labels. */
	postcodeRepair?: boolean
	/**
	 * #690: title-case a detected all-caps ASCII input before the model (all-caps registry/compliance data is partly
	 * OOD). Detection-gated — mixed-case + non-ASCII input is untouched. Off by default.
	 */
	normalizeCase?: boolean
}

export interface AddressClassifier {
	parse(text: string, opts?: ClassifierOpts): Promise<AddressTree>
}

/**
 * Injectable stage implementations. All optional — when a stage is absent, the coordinator either skips it (resolver)
 * or substitutes a no-op stub (normalize / queryShape / locale gate / kind classifier). The classifier is required for
 * the full pipeline path; without it, the coordinator can only fast-path on QueryShape known-formats.
 */
export interface RuntimePipelineStages {
	normalize?: (raw: string, opts?: { locale?: string }) => NormalizedInputLite
	computeQueryShape?: (input: NormalizedInputLite | string, opts?: { locale?: string }) => QueryShapeLite
	detectLocale?: (input: NormalizedInputLite, shape: QueryShapeLite, opts?: { hint?: LocaleTag }) => Promise<LocaleHint>
	classifyKind?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<QueryKindResult>
	/**
	 * Coarse country router (#244). A `(normalizedText) → { country, confidence, posterior? }` predictor (a
	 * `CoarsePlacer`-backed fn); `country: null` ⇒ abstained, `"OTHER"` ⇒ off-map. When provided, a confident IN-MAP
	 * guess becomes a SOFT country prior fed into the resolver's #369 `anchorPosterior` re-rank (boosts the right-country
	 * candidate, never filters); it defers to a caller-supplied posterior (a stronger postcode anchor) and is a no-op on
	 * abstain/OTHER. Off by default → byte-stable.
	 *
	 * `posterior` (residual upgrade) is the full per-in-map-country distribution: when present it IS the
	 * `anchorPosterior` (so the resolver breaks country-ambiguous ties with its own place-level evidence); when absent
	 * the coordinator falls back to the one-hot `{ [country]: confidence }`. See
	 * docs/articles/plan/2026-06-14-coarse-placer-soft-signal-spec.md.
	 */
	placeCountry?: (normalizedText: string) => {
		country: string | null
		confidence: number
		posterior?: Record<string, number>
	}
	/**
	 * Stage 2.7 phrase grouper. Emits coherent input-unit proposals consumed by Stage 3 (as conditioning) and Stage 5 (as
	 * boundary candidates). Hard dep in v0.5.0; pre-v0.5.0 callers run with no grouper and the result `phraseProposals`
	 * field is empty.
	 */
	groupPhrases?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<PhraseProposal[]>
	classifier?: AddressClassifier
	/**
	 * Pre-built FST gazetteer matcher. When provided, gazetteer matches produce additive emission biases during
	 * classification.
	 */
	fst?: FSTMatcherLike
	resolver?: Resolver
	/**
	 * The gazetteer BACKEND (lower-level than `resolver`), enabling the reconciler's concordance axes (#478): a bounded
	 * pre-fetch turns it into the resolver-candidate + parent-chain lookups `reconcileSpans` scores with. Optional —
	 * absent, reconcile runs classifier-only (today's behavior, byte-stable).
	 */
	resolverBackend?: ResolverBackend
	/**
	 * The "rule source" for arbitration (#478 increment 3): `(normalizedText, locale) → rule proposals`, derived from the
	 * SOLVED v0 parser (its solver-coordinated output, not raw classifier firings). Invoked only when `opts.arbitrate` is
	 * set. Typically wired by `createRuntimePipeline` from `createAddressParser` + `solutionToProposals`. Absent ⇒
	 * arbitration is a no-op.
	 */
	ruleProposer?: (normalizedText: string, locale: string) => Promise<ClassificationProposal[]>
}

export interface PipelineTiming {
	[stage: string]: number // ms
}

/** Result of one `runPipeline` call. */
export interface PipelineResult {
	input: string
	normalized: NormalizedInputLite
	queryShape: QueryShapeLite
	locale: LocaleHint
	kind: QueryKindResult
	/**
	 * Stage 2.7 phrase proposals when a grouper was wired. Empty array when the coordinator ran with no grouper
	 * (pre-v0.5.0 callers) or when the fast-path skipped Stage 2.7. Stage 3 consumes this as conditioning; Stage 5
	 * consumes it as boundary candidates.
	 */
	phraseProposals: PhraseProposal[]
	tree: AddressTree
	timing: PipelineTiming
	/** Which path the coordinator took. `"fast-path"` skipped stages 3-5. */
	path: "fast-path" | "full"
}
