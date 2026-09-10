/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The fix registry: the checks that can plan their own repair, listed the way `registry.ts` lists the checks.
 *
 *   Membership is deliberately narrow. A check earns a fix when the repair is a MECHANICAL consequence of the
 *   diagnostic — a file belongs at another path, and every specifier that named it follows. A check whose repair is a
 *   judgment call has no entry here, and adding one to save an argument is how a health check starts deciding what
 *   the code should say.
 */

import { recipePrefixDirectoriesFix } from "#checks/recipe-prefix-directories"
import type { RepoFix } from "#fix"

/**
 * Every check that can plan its own repair. `mwops health fix <check>` looks a fix up here by the check's id.
 */
export const fixes: ReadonlyArray<RepoFix> = [recipePrefixDirectoriesFix]

/**
 * The fix for a check id, or nothing when that check has no mechanical repair.
 */
export function findFix(id: string): RepoFix | undefined {
	return fixes.find((fix) => fix.id === id)
}
