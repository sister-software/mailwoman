/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This registry is the package's executable entry point. Knip treats it as such.
 *   Knip reports any operation omitted from this array as dead code. The retired `scripts/**`
 *   entry glob could not provide that check. Adapters (`@mailwoman/ops-cli` and the release MCP)
 *   iterate this array. They do not import operation modules directly.
 */

import { findOperation as findRegisteredOperation } from "@mailwoman/core/scripting"

import type { ReleaseOperation } from "#operation"
import { blessPackage } from "#operations/bless-package"
import { checkParity } from "#operations/check-parity"
import { cleanOperation } from "#operations/clean"
import { copyWeightsOperation } from "#operations/copy-weights"
import { deployTargets } from "#operations/deploy-targets"
import { fetchHFWeightsOperation } from "#operations/fetch-hf-weights"
import { generatedSurfaces } from "#operations/generated-surfaces"
import { linkWeightsOverlayOperation } from "#operations/link-weights-overlay"
import { plan } from "#operations/plan"
import { preflight } from "#operations/preflight"
import { prepareVersion } from "#operations/prepare-version"
import { publishWorkspaceOperation } from "#operations/publish-workspace"
import { rightsAudit } from "#operations/rights-audit"
import { sbom } from "#operations/sbom"
import { scaffoldWeightsOverlayOperation } from "#operations/scaffold-weights-overlay"
import { smokeCleanInstallOperation } from "#operations/smoke/clean-install"
import { smokeGetStartedOperation } from "#operations/smoke/get-started"
import { stageWeightsCacheOperation } from "#operations/stage-weights-cache"
import { verifyMetadata } from "#operations/verify-metadata"
import { writeRightsFiles } from "#operations/write-rights-files"

/**
 * Every release operation in adapter order.
 *
 * The plan comes first, followed by read-only checks.
 * Local writes follow in release order.
 * The two external writes come last.
 */
export const operations: ReadonlyArray<ReleaseOperation<unknown, unknown>> = [
	plan,
	verifyMetadata,
	checkParity,
	rightsAudit,
	cleanOperation,
	prepareVersion,
	generatedSurfaces,
	writeRightsFiles,
	copyWeightsOperation,
	fetchHFWeightsOperation,
	preflight,
	smokeCleanInstallOperation,
	smokeGetStartedOperation,
	sbom,
	linkWeightsOverlayOperation,
	stageWeightsCacheOperation,
	scaffoldWeightsOverlayOperation,
	deployTargets,
	publishWorkspaceOperation,
	blessPackage,
] as ReadonlyArray<ReleaseOperation<unknown, unknown>>

/**
 * Look an operation up by id, or `undefined`.
 */
export function findOperation(id: string): ReleaseOperation<unknown, unknown> | undefined {
	return findRegisteredOperation(operations, "release", id)
}
