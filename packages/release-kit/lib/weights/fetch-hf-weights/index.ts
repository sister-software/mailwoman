// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Public entry point for release-weight materialization.
 */

export {
	hfFamilyBase,
	hfVersionBase,
	planCharFamilyArtifacts,
	planWeightsMaterialization,
	readBaseModelVersion,
} from "#weights/fetch-hf-weights/plan"

export type { ArtifactOrigin, HFMaterializationReport, WeightsArtifactPlan } from "#weights/fetch-hf-weights/plan"
export { fetchHFWeights, reportHFMaterialization } from "#weights/fetch-hf-weights/fetch"
export type { FetchHFWeightsOptions } from "#weights/fetch-hf-weights/fetch"
