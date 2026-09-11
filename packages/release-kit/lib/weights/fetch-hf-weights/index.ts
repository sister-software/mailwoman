/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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
