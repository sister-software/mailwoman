/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { MachinePreferences } from "@mailwoman/core/pipeline"

export interface DetectLocaleOpts {
	/**
	 * Caller's locale hint. When set, returned at confidence 1.0 with source="caller".
	 */
	hint?: Intl.UnicodeBCP47LocaleIdentifier
	/**
	 * Explicit process configuration, below a per-call caller hint but above inferred machine preferences.
	 */
	environmentLocale?: Intl.UnicodeBCP47LocaleIdentifier
	/**
	 * Host/browser preferences, consulted only when input rules have no signal beyond the fallback.
	 */
	machinePreferences?: MachinePreferences
	/**
	 * Below this confidence, the detector returns the top candidate but also surfaces alternatives. Default 0.7.
	 */
	confidenceFloor?: number
}
