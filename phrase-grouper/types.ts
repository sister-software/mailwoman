/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/** Re-exports of the canonical types from `@mailwoman/core/pipeline`. */
export type { LocaleHint, PhraseGrouper, PhraseKind, PhraseProposal } from "@mailwoman/core/pipeline"

/** Re-export of the canonical `Section` type from `@mailwoman/core/types`. `Section = Span`. */
export type { Section } from "@mailwoman/core/types"

/**
 * Minimal `NormalizedInput` shape consumed by `groupPhrases`. Compatible with
 * `@mailwoman/normalize`'s output.
 */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/**
 * Minimal `QueryShape` shape consumed by `groupPhrases`. Compatible with `@mailwoman/query-shape`'s
 * output.
 */
export interface QueryShapeLike {
	knownFormats: ReadonlyArray<{
		format: string
		span: { start: number; end: number }
		confidence: number
	}>
	segments?: ReadonlyArray<{ body: string; index: number; span?: { start: number; end: number } }>
	tokenClasses?: ReadonlyArray<{
		span: { start: number; end: number; body: string }
		class: string
		length: number
	}>
	characterClass?: string
	totalLength?: number
}

export interface GroupPhrasesOpts {
	/** Reserved for future tunables (e.g. confidence floor, per-kind biasing). Currently unused. */
	confidenceFloor?: number
}
