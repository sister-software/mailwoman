/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Phase 2 measured-decision outcome types.
 */

import type { Phase2Decision } from "#eval-harness/phase-2-decision/decision"

/**
 * The counts a decision reads.
 */
export interface Phase2Counts {
	resolutionChecks: number
	resolutionMet: number
	evidenceChecks: number
	evidenceMet: number
	controlChecks: number
	controlMet: number
	controlMisses: number
}

/**
 * What a run was measured against, beside what the ruler pinned.
 */
export interface Phase2Comparability {
	/**
	 * Every pinned artifact whose observed identity differs, with both values included.
	 *
	 * Empty means the run is comparable to the receipts the ruler cites as baselines.
	 */
	deviations: string[]
}

export interface Phase2Verdict {
	decision: Phase2Decision
	counts: Phase2Counts
	/**
	 * `partial` whenever any registered lane is blocked.
	 *
	 * Always stated: a verdict over three of four lanes is a different claim from a verdict
	 * over all of them, and only one of the two is what this run produced.
	 */
	coverage: "complete" | "partial"
	blockedLanes: string[]
	/**
	 * `deviated` when the run's artifacts differ from the pins.
	 *
	 * Reported, never a decision input.
	 * A decision measured on other artifacts is still a decision about those artifacts.
	 */
	comparability: "pinned" | "deviated"
	pinDeviations: string[]
	/**
	 * The default-change bar rows that do not read `met`.
	 *
	 * This decision records opt-in behavior and grants no authorization for a default change.
	 * Never an input.
	 */
	defaultChangeBarUnmetRows: number[]
	reasons: string[]
	/**
	 * Every check that missed its bar, with the arithmetic included.
	 */
	misses: string[]
}
