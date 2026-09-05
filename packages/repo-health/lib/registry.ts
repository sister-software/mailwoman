/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The registry of repository health checks — the ONLY executable entry point of this package, and the file knip
 *   treats as such. A check that is not listed here is dead code and knip reports it. `mwops health <id>` and
 *   `mwops health all` iterate this array.
 */

import type { RepoCheck } from "#check"
import { debtCheck } from "#checks/debt"
import { exportsCheck } from "#checks/exports"
import { licenseRegisterCheck } from "#checks/license-register"
import { manifestTargetsCheck } from "#checks/manifest-targets"
import { noRootScriptsCheck } from "#checks/no-root-scripts"
import { nodeModulesReacharoundCheck } from "#checks/node-modules-reacharound"
import { privateNameShadowsCheck } from "#checks/private-name-shadows"
import { runtimeFlagsCheck } from "#checks/runtime-flags"
import { testContractCheck } from "#checks/test-contract"
import { typecheckTestsCheck } from "#checks/typecheck-tests"
import { versionSyncCheck } from "#checks/version-sync"
import { vocabCensusCheck } from "#checks/vocab-census"

/**
 * Every health check, in the order `mwops health all` runs them: the ones that only read files first, then the ones
 * that spawn Vale, knip and tsc.
 */
export const checks: ReadonlyArray<RepoCheck> = [
	versionSyncCheck,
	licenseRegisterCheck,
	testContractCheck,
	nodeModulesReacharoundCheck,
	noRootScriptsCheck,
	manifestTargetsCheck,
	privateNameShadowsCheck,
	runtimeFlagsCheck,
	debtCheck,
	vocabCensusCheck,
	exportsCheck,
	typecheckTestsCheck,
]

export function findCheck(id: string): RepoCheck | undefined {
	return checks.find((check) => check.id === id)
}
