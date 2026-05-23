/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/** Re-exports of the canonical types from `@mailwoman/core/pipeline`. */
export type { LocaleHint, LocaleTag } from "@mailwoman/core/pipeline"

/**
 * Minimal `NormalizedInput` shape consumed by `detectLocale`. Compatible with
 * `@mailwoman/normalize`'s output.
 */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/**
 * Minimal `QueryShape` shape consumed by `detectLocale`. Compatible with `@mailwoman/query-shape`'s
 * output.
 */
export interface QueryShapeLike {
	knownFormats: ReadonlyArray<{
		format: string
		span: { start: number; end: number }
		confidence: number
	}>
	characterClass?: string
	totalLength?: number
}

export interface DetectLocaleOpts {
	/** Caller's locale hint. When set, returned at confidence 1.0 with source="caller". */
	hint?: string
	/**
	 * Below this confidence, the detector returns the top candidate but also surfaces alternatives.
	 * Default 0.7.
	 */
	confidenceFloor?: number
}
