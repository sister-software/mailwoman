/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The shape a repairable check takes and the line between the two registries.
 *
 * A `RepoFix` answers one check's diagnostics with module moves and replacement manifests. It cannot write anything,
 * because only `#move/apply` performs the apply.
 */

import type { RepoContext } from "#check"
import type { ManifestReplacement, ModuleMove } from "#move/types"

/**
 * The repair a fix proposes.
 * Both lists are empty when the check already passes.
 */
export interface RepoFixPlan {
	moves: ModuleMove[]
	manifests?: ManifestReplacement[]
}

export interface RepoFix {
	/**
	 * The id of the check this repairs, so a diagnostic names its own action.
	 */
	id: string
	description: string
	/**
	 * The moves and manifest replacements that would clear the check's diagnostics.
	 */
	plan(context: RepoContext): Promise<RepoFixPlan>
}
