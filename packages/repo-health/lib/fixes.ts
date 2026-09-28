/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The fix registry: the checks that can plan their own repair, listed the way `registry.ts` lists the checks.
 *
 * A check warrants a fix only when the repair is a mechanical consequence of the diagnostic.
 */

import { prefixDirectoriesFix } from "#checks/prefix-directories"
import type { RepoFix } from "#fix"

/**
 * Every check that can plan its own repair.
 */
export const fixes: ReadonlyArray<RepoFix> = [prefixDirectoriesFix]

/**
 * The fix for a check id, or no fix when that check has no mechanical repair.
 */
export function findFix(id: string): RepoFix | undefined {
	return fixes.find((fix) => fix.id === id)
}
