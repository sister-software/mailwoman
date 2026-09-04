/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The registry of release operations — the ONLY executable entry point of this package, and the file knip treats as
 *   such. An operation that is not listed here is dead code and knip reports it, which is the property the retired
 *   `scripts/**` entry glob could never provide. Adapters (`@mailwoman/ops-cli`, the release MCP) iterate this array;
 *   they never import an operation module directly.
 */

import type { ReleaseOperation } from "#operation"
import { blessPackage } from "#operations/bless-package"
import { checkParity } from "#operations/check-parity"
import { copyWeightsOperation } from "#operations/copy-weights"
import { fetchHFWeightsOperation } from "#operations/fetch-hf-weights"
import { generatedSurfaces } from "#operations/generated-surfaces"
import { linkWeightsOverlayOperation } from "#operations/link-weights-overlay"
import { plan } from "#operations/plan"
import { preflight } from "#operations/preflight"
import { prepareVersion } from "#operations/prepare-version"
import { publishWorkspaceOperation } from "#operations/publish-workspace"
import { sbom } from "#operations/sbom"
import { scaffoldWeightsOverlayOperation } from "#operations/scaffold-weights-overlay"
import { smokeCleanInstallOperation } from "#operations/smoke-clean-install"
import { stageWeightsCacheOperation } from "#operations/stage-weights-cache"
import { verifyMetadata } from "#operations/verify-metadata"

/**
 * Every release operation, in the order an adapter lists them: the plan first, then the read-only checks, the local
 * writes in release order, and the two external writes last.
 */
export const operations: ReadonlyArray<ReleaseOperation<unknown, unknown>> = [
	plan,
	verifyMetadata,
	checkParity,
	prepareVersion,
	generatedSurfaces,
	copyWeightsOperation,
	fetchHFWeightsOperation,
	preflight,
	smokeCleanInstallOperation,
	sbom,
	linkWeightsOverlayOperation,
	stageWeightsCacheOperation,
	scaffoldWeightsOverlayOperation,
	publishWorkspaceOperation,
	blessPackage,
] as ReadonlyArray<ReleaseOperation<unknown, unknown>>

/**
 * Look an operation up by id, or `undefined`.
 */
export function findOperation(id: string): ReleaseOperation<unknown, unknown> | undefined {
	return operations.find((operation) => operation.id === id)
}
