/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { MachinePreferences } from "@mailwoman/core/pipeline"

/**
 * Re-exports of the canonical types from `@mailwoman/core/pipeline`.
 */
export type { LocaleHint, LocaleTag, MachinePreferences } from "@mailwoman/core/pipeline"

/**
 * The minimal input shapes consumed by `detectLocale` come from `@mailwoman/query-shape` — one declaration shared by
 * every Stage-2.x consumer. `QueryShapeLike` stays this package's public name for its narrow read-only view.
 */
export type { NormalizedInputLite, QueryShapeFormatsView as QueryShapeLike } from "@mailwoman/query-shape"

export interface DetectLocaleOpts {
	/**
	 * Caller's locale hint. When set, returned at confidence 1.0 with source="caller".
	 */
	hint?: string
	/**
	 * Explicit process configuration, below a per-call caller hint but above inferred machine preferences.
	 */
	environmentLocale?: string
	/**
	 * Host/browser preferences, consulted only when input rules have no signal beyond the fallback.
	 */
	machinePreferences?: MachinePreferences
	/**
	 * Below this confidence, the detector returns the top candidate but also surfaces alternatives. Default 0.7.
	 */
	confidenceFloor?: number
}
