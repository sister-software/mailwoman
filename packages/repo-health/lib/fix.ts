/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The shape a repairable check takes, and the line between the two registries.
 *
 *   `RepoCheck` returns diagnostics and can do nothing else — that admission rule is in its type and stays there. A
 *   `RepoFix` is the separate, opt-in half: it answers ONE check's diagnostics with a list of module moves, and it
 *   still cannot write anything, because planning and applying are different operations and only `#move/apply`
 *   performs the second. `mwops health fix <check>` is the caller, the way `mwops health baseline debt` is the caller
 *   for the other non-check export this package has.
 */

import type { RepoContext } from "#check"
import type { ModuleMove } from "#move/types"

export interface RepoFix {
	/**
	 * The id of the check this repairs. They match, so a diagnostic names its own remedy.
	 */
	id: string
	description: string
	/**
	 * The moves that would clear the check's diagnostics, or an empty list when it already passes.
	 */
	plan(context: RepoContext): Promise<ModuleMove[]>
}
