// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Public entry point for release-weight materialization.
 */

export {
	hfVersionBase,
	planCharFamilyArtifacts,
	planWeightsMaterialization,
	readBaseModelVersion,
} from "#release-kit/weights/fetch-hf-weights/plan"

export type { ArtifactOrigin } from "#release-kit/weights/fetch-hf-weights/plan"

export { fetchHFWeights, reportHFMaterialization } from "#release-kit/weights/fetch-hf-weights/fetch"
