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
import { bundleGraphCheck } from "#checks/bundle-graph"
import { cliFlagPropertiesCheck } from "#checks/cli-flag-properties"
import { debtCheck } from "#checks/debt"
import { docLinkTargetsCheck } from "#checks/doc-link-targets"
import { exportNameAffixCheck } from "#checks/export-name-affix"
import { exportsCheck } from "#checks/exports"
import { licenseRegisterCheck } from "#checks/license-register"
import { manifestTargetsCheck } from "#checks/manifest-targets"
import { moduleCohesionCheck } from "#checks/module/cohesion"
import { moduleSurfaceCheck } from "#checks/module/surface"
import { noRootScriptsCheck } from "#checks/no-root-scripts"
import { nodeModulesReacharoundCheck } from "#checks/node-modules-reacharound"
import { prefixDirectoriesCheck } from "#checks/prefix-directories"
import { privateNameShadowsCheck } from "#checks/private-name-shadows"
import { runtimeFlagsCheck } from "#checks/runtime-flags"
import { stylesheetContractCheck } from "#checks/stylesheet-contract"
import { testContractCheck } from "#checks/test-contract"
import { typecheckTestsCheck } from "#checks/typecheck-tests"
import { versionSyncCheck } from "#checks/version-sync"
import { vocabCensusCheck } from "#checks/vocab-census"

/**
 * Every health check, in the order `mwops health all` runs them: the ones that only read files first, then the ones
 * that bundle with esbuild or spawn Vale, knip and tsc.
 */
export const checks: ReadonlyArray<RepoCheck> = [
	versionSyncCheck,
	licenseRegisterCheck,
	testContractCheck,
	nodeModulesReacharoundCheck,
	noRootScriptsCheck,
	manifestTargetsCheck,
	moduleSurfaceCheck,
	moduleCohesionCheck,
	privateNameShadowsCheck,
	cliFlagPropertiesCheck,
	prefixDirectoriesCheck,
	exportNameAffixCheck,
	docLinkTargetsCheck,
	stylesheetContractCheck,
	runtimeFlagsCheck,
	debtCheck,
	bundleGraphCheck,
	vocabCensusCheck,
	exportsCheck,
	typecheckTestsCheck,
]

export function findCheck(id: string): RepoCheck | undefined {
	return checks.find((check) => check.id === id)
}
