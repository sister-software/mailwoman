/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The fix registry: the checks that can plan their own repair, listed the way `registry.ts` lists the checks.
 *
 * A check warrants a fix only when the repair is a mechanical consequence of the diagnostic.
 */

import { nestedIndexFix } from "#repo-health/checks/nested-index"
import { prefixDirectoriesFix } from "#repo-health/checks/prefix-directories"
import { workspaceExportsFix, workspaceFilesFix } from "#repo-health/checks/workspace-manifest"
import type { RepoFix } from "#repo-health/fix"

/**
 * Every check that can plan its own repair.
 */
export const fixes: ReadonlyArray<RepoFix> = [
	prefixDirectoriesFix,
	nestedIndexFix,
	workspaceExportsFix,
	workspaceFilesFix,
]

/**
 * The fix for a check id, or no fix when that check has no mechanical repair.
 */
export function findFix(id: string): RepoFix | null {
	return fixes.find((fix) => fix.id === id) ?? null
}
