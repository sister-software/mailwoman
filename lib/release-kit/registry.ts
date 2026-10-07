/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This registry is the package's executable entry point. Knip treats it as such.
 *   Knip reports any operation omitted from this array as dead code. The retired `scripts/**`
 *   entry glob could not provide that check. Adapters (`mwops` and the release MCP server)
 *   iterate this array. They do not import operation modules directly.
 */

import { findOperation as findRegisteredOperation } from "@mailwoman/core/scripting"

import type { ReleaseOperation } from "#release-kit/operation"
import { blessPackage } from "#release-kit/operations/bless-package"
import { checkParity } from "#release-kit/operations/check-parity"
import { cleanOperation } from "#release-kit/operations/clean"
import { copyWeightsOperation } from "#release-kit/operations/copy-weights"
import { deployTargets } from "#release-kit/operations/deploy-targets"
import { fetchHFWeightsOperation } from "#release-kit/operations/fetch-hf-weights"
import { generatedSurfaces } from "#release-kit/operations/generated-surfaces"
import { linkWeightsOverlayOperation } from "#release-kit/operations/link-weights-overlay"
import { plan } from "#release-kit/operations/plan"
import { preflight } from "#release-kit/operations/preflight"
import { prepareVersion } from "#release-kit/operations/prepare-version"
import { publishWorkspaceOperation } from "#release-kit/operations/publish-workspace"
import { rightsAudit } from "#release-kit/operations/rights-audit"
import { sbom } from "#release-kit/operations/sbom"
import { scaffoldWeightsOverlayOperation } from "#release-kit/operations/scaffold-weights-overlay"
import { smokeCleanInstallOperation } from "#release-kit/operations/smoke/clean-install"
import { smokeGetStartedOperation } from "#release-kit/operations/smoke/get-started"
import { stageWeightsCacheOperation } from "#release-kit/operations/stage-weights-cache"
import { verifyMetadata } from "#release-kit/operations/verify-metadata"
import { writeRightsFiles } from "#release-kit/operations/write-rights-files"

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
export function findOperation(id: string): ReleaseOperation<unknown, unknown> | null {
	return findRegisteredOperation(operations, "release", id)
}
