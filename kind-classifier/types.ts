/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/** Re-exports of the canonical types from `@mailwoman/core/pipeline`. */
export type { LocaleHint, QueryKind, QueryKindResult } from "@mailwoman/core/pipeline"

/**
 * Minimal `NormalizedInput` shape consumed by `classifyKind`. Compatible with
 * `@mailwoman/normalize`'s output.
 */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/**
 * Minimal `QueryShape` shape consumed by `classifyKind`. Compatible with `@mailwoman/query-shape`'s
 * output.
 */
export interface QueryShapeLike {
	knownFormats: ReadonlyArray<{
		format: string
		span: { start: number; end: number }
		confidence: number
	}>
	segments?: ReadonlyArray<{ body: string; index: number }>
	characterClass?: string
	totalLength?: number
}
