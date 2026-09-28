/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The shape a repairable check takes and the line between the two registries.
 *
 * A `RepoFix` answers one check's diagnostics with a list of module moves and cannot write anything, because only
 * `#move/apply` performs the apply.
 */

import type { RepoContext } from "#check"
import type { ModuleMove } from "#move/types"

export interface RepoFix {
	/**
	 * The id of the check this repairs, so a diagnostic names its own action.
	 */
	id: string
	description: string
	/**
	 * The moves that would clear the check's diagnostics, or an empty list when it already passes.
	 */
	plan(context: RepoContext): Promise<ModuleMove[]>
}
