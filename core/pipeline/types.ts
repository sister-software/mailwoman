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

export type LocaleTag = string

/** Optional user-location signal for Stage 6 resolver scoring. */
export type UserLocation = { lat: number; lon: number } | { country: string } | { region: string; country: string }

/** Common opts threaded through every stage. */
export interface PipelineOpts {
	locale?: LocaleTag
	userLocation?: UserLocation
	/** Disable fast-path shortcuts; always run the full pipeline. */
	forceFullPipeline?: boolean
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
 * Stage 3 contract: classifier that turns a text into an `AddressTree`. Structural — any of
 * `@mailwoman/neural`'s `NeuralAddressClassifier`, a rule-based classifier, or a fake for tests
 * satisfies this.
 */
export interface AddressClassifier {
	parse(text: string, opts?: { queryShape?: QueryShapeLite }): Promise<AddressTree>
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
	classifier?: AddressClassifier
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
	tree: AddressTree
	timing: PipelineTiming
	/** Which path the coordinator took. `"fast-path"` skipped stages 3-5. */
	path: "fast-path" | "full"
}
