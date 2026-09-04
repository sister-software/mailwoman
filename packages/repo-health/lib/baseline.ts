/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one mutation this package performs, and it is NOT a check: rewriting `baseline.json` after a reviewed
 *   reduction. The registry never lists it; `mwops health baseline debt` calls it by name, and nothing else does.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { relative } from "path-ts"

import type { RepoContext } from "#check"
import { BASELINE_PATH, computeDebtCounters, type DebtCounters } from "#checks/debt"

export interface BaselineWrite {
	/**
	 * The baseline file, repo-relative.
	 */
	file: string
	counters: DebtCounters
}

/**
 * Count every debt counter over the tracked tree and record the readings as the new baseline.
 */
export async function writeBaseline(context: RepoContext): Promise<BaselineWrite> {
	const counters = await computeDebtCounters(context)

	await writeLocalJSONFile(counters, BASELINE_PATH)

	return { file: relative(context.repoRoot, BASELINE_PATH), counters }
}
