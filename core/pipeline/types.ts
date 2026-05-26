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
import type { ResolveOpts, Resolver } from "../resolver/types.js"
import type { Section } from "../types/classifier.js"

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
	 * Enable the joint-reconcile path (Stage 5 beam search). Opt-in until phrase-grouper proposal
	 * quality supports multi-word streets/localities — currently produces single-token spans.
	 * Requires phrase grouper + classifier with `parseWithLogits`.
	 */
	forceJointReconcile?: boolean
	/** Hard cap on lookups the resolver may issue; passed through. */
	resolveOpts?: ResolveOpts
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
 * Stage 2.7 phrase grouper output. Coarse phrase-shape hypothesis attached to a `Section` (sub-Span
 * of the tokenized input). The classifier (Stage 3) conditions on these proposals so it can answer
 * the simpler "what type is this proposed span?" instead of jointly discovering boundaries and
 * types. The reconciler (Stage 5) consumes them as boundary candidates for joint decoding.
 *
 * Taxonomy is purely structural — no place-name knowledge. A `LOCALITY_PHRASE` proposal is "this
 * looks shaped like a multi-word capitalized phrase that could be a city name" — not "this IS New
 * York." Typing the span is the classifier's job.
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
 * Per "possibilities not constraints", emit a proposal whenever a rule fires — overlapping
 * proposals over the same tokens are expected (e.g. `Saint Petersburg` may surface as one
 * `LOCALITY_PHRASE` AND two `LOCALITY_PHRASE`s, with confidence ordering signalling which the
 * grouper prefers).
 */
export interface PhraseProposal {
	span: Section
	kindHypothesis: PhraseKind
	confidence: number
}

/**
 * Stage 2.7 contract. Structural — any of the rule-based grouper (`@mailwoman/phrase-grouper`), a
 * learned span proposer (future), or a fake for tests satisfies this. Async so the coordinator can
 * stay uniform even when implementations call into models.
 */
export interface PhraseGrouper {
	group(input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint): Promise<PhraseProposal[]>
}

/**
 * Stage 3 contract: classifier that turns a text into an `AddressTree`. Structural — any of
 * `@mailwoman/neural`'s `NeuralAddressClassifier`, a rule-based classifier, or a fake for tests
 * satisfies this.
 */
/**
 * Structural type for the FST gazetteer matcher, compatible with @mailwoman/resolver-wof-sqlite's
 * FstMatcher.
 */
export interface FstMatcherLike {
	walk(tokens: string[]): { stateId: number; accepted: boolean; depth: number } | null
	walkFrom(
		prev: { stateId: number; depth: number },
		token: string
	): { stateId: number; accepted: boolean; depth: number } | null
	accepting(stateId: number): Array<{ wofId: number; placetype: string; importance: number }>
}

export interface ClassifierOpts {
	queryShape?: QueryShapeLite
	fst?: FstMatcherLike
	fstBiasScale?: number
}

export interface AddressClassifier {
	parse(text: string, opts?: ClassifierOpts): Promise<AddressTree>
}

/**
 * Injectable stage implementations. All optional — when a stage is absent, the coordinator either
 * skips it (resolver) or substitutes a no-op stub (normalize / queryShape / locale gate / kind
 * classifier). The classifier is required for the full pipeline path; without it, the coordinator
 * can only fast-path on QueryShape known-formats.
 */
export interface RuntimePipelineStages {
	normalize?: (raw: string, opts?: { locale?: string }) => NormalizedInputLite
	computeQueryShape?: (input: NormalizedInputLite | string, opts?: { locale?: string }) => QueryShapeLite
	detectLocale?: (input: NormalizedInputLite, shape: QueryShapeLite, opts?: { hint?: LocaleTag }) => Promise<LocaleHint>
	classifyKind?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<QueryKindResult>
	/**
	 * Stage 2.7 phrase grouper. Emits coherent input-unit proposals consumed by Stage 3 (as
	 * conditioning) and Stage 5 (as boundary candidates). Hard dep in v0.5.0; pre-v0.5.0 callers run
	 * with no grouper and the result `phraseProposals` field is empty.
	 */
	groupPhrases?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<PhraseProposal[]>
	classifier?: AddressClassifier
	/**
	 * Pre-built FST gazetteer matcher. When provided, gazetteer matches produce additive emission
	 * biases during classification.
	 */
	fst?: FstMatcherLike
	resolver?: Resolver
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
	 * Stage 2.7 phrase proposals when a grouper was wired. Empty array when the coordinator ran with
	 * no grouper (pre-v0.5.0 callers) or when the fast-path skipped Stage 2.7. Stage 3 consumes this
	 * as conditioning; Stage 5 consumes it as boundary candidates.
	 */
	phraseProposals: PhraseProposal[]
	tree: AddressTree
	timing: PipelineTiming
	/** Which path the coordinator took. `"fast-path"` skipped stages 3-5. */
	path: "fast-path" | "full"
}
