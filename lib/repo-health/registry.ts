/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The registry of repository health checks — the only executable entry point of this package. Knip
 *   treats as such. A check that is not listed here is dead code and knip reports it. `mwops health <id>` and
 *   `mwops health all` iterate this array.
 */

import type { RepoCheck } from "#repo-health/check"
import { bundleGraphCheck } from "#repo-health/checks/bundle-graph"
import { cliFlagPropertiesCheck } from "#repo-health/checks/cli-flag-properties"
import { countryBranchesCheck } from "#repo-health/checks/country-branches"
import { dataProvenanceCheck } from "#repo-health/checks/data-provenance"
import { debtCheck } from "#repo-health/checks/debt"
import { docLinkTargetsCheck } from "#repo-health/checks/doc-link-targets"
import { duplicateExportedShapeCheck } from "#repo-health/checks/duplicate-exported-shape"
import { exportNameAffixCheck } from "#repo-health/checks/export-name-affix"
import { exportsCheck } from "#repo-health/checks/exports"
import { licenseRegisterCheck } from "#repo-health/checks/license-register"
import { localeScopeCheck } from "#repo-health/checks/locale/scope"
import { localeTablesCheck } from "#repo-health/checks/locale/tables"
import { manifestTargetsCheck } from "#repo-health/checks/manifest-targets"
import { moduleCohesionCheck } from "#repo-health/checks/module/cohesion"
import { moduleReexportsCheck } from "#repo-health/checks/module/reexports"
import { moduleSurfaceCheck } from "#repo-health/checks/module/surface"
import { nestedIndexCheck } from "#repo-health/checks/nested-index"
import { noRootScriptsCheck } from "#repo-health/checks/no-root-scripts"
import { nodeModulesReacharoundCheck } from "#repo-health/checks/node-modules-reacharound"
import { packageLicenseCheck } from "#repo-health/checks/package-license"
import { prefixDirectoriesCheck } from "#repo-health/checks/prefix-directories"
import { privateNameShadowsCheck } from "#repo-health/checks/private-name-shadows"
import { publishedBundlesCheck } from "#repo-health/checks/published-bundles"
import { pythonPrefixDirectoriesCheck } from "#repo-health/checks/python-prefix-directories"
import { rightsChainCheck } from "#repo-health/checks/rights-chain"
import { runtimeFlagsCheck } from "#repo-health/checks/runtime-flags"
import { stalePathLiteralsCheck } from "#repo-health/checks/stale-path-literals"
import { stylesheetCheck } from "#repo-health/checks/stylesheet-check"
import { testLayoutCheck } from "#repo-health/checks/test-layout"
import { thirdPartyNoticesCheck } from "#repo-health/checks/third-party-notices"
import { typecheckTestsCheck } from "#repo-health/checks/typecheck-tests"
import { versionSyncCheck } from "#repo-health/checks/version-sync"
import { vocabCensusCheck } from "#repo-health/checks/vocab-census"
import { weightsFamilyCheck } from "#repo-health/checks/weights/family"
import { weightsReconciliationCheck } from "#repo-health/checks/weights/reconciliation"
import { weightsRightsCheck } from "#repo-health/checks/weights/rights"
import { wireIdentifiersCheck } from "#repo-health/checks/wire-identifiers"
import { workspaceExportsCheck, workspaceFilesCheck } from "#repo-health/checks/workspace-manifest"

/**
 * Every health check, in the order `mwops health all` runs them: the ones that only read
 * files first, then the ones that bundle with esbuild or spawn Vale, knip and tsc.
 */
export const checks: ReadonlyArray<RepoCheck> = [
	versionSyncCheck,
	packageLicenseCheck,
	rightsChainCheck,
	thirdPartyNoticesCheck,
	licenseRegisterCheck,
	localeTablesCheck,
	localeScopeCheck,
	weightsFamilyCheck,
	weightsRightsCheck,
	weightsReconciliationCheck,
	dataProvenanceCheck,
	publishedBundlesCheck,
	testLayoutCheck,
	nodeModulesReacharoundCheck,
	noRootScriptsCheck,
	manifestTargetsCheck,
	workspaceExportsCheck,
	workspaceFilesCheck,
	moduleSurfaceCheck,
	moduleCohesionCheck,
	moduleReexportsCheck,
	privateNameShadowsCheck,
	cliFlagPropertiesCheck,
	prefixDirectoriesCheck,
	nestedIndexCheck,
	pythonPrefixDirectoriesCheck,
	exportNameAffixCheck,
	docLinkTargetsCheck,
	duplicateExportedShapeCheck,
	stylesheetCheck,
	runtimeFlagsCheck,
	wireIdentifiersCheck,
	stalePathLiteralsCheck,
	countryBranchesCheck,
	debtCheck,
	bundleGraphCheck,
	vocabCensusCheck,
	exportsCheck,
	typecheckTestsCheck,
]

export function findCheck(id: string): RepoCheck | null {
	return checks.find((check) => check.id === id) ?? null
}
