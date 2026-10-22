/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structure sources published in the Netherlands.
 */

import { LicenseReviewState, type LicenseDecision } from "@mailwoman/core/license/decision"

import { RESEARCH_HANDOFF_NOTE } from "#research"
import { StructureDetail, type StructureOperation, type StructureSource } from "#types"

/**
 * The Netherlands' structure sources, from the 2026-10-22 landmark-data research handoff.
 */
export const NL_SOURCES: readonly StructureSource[] = [
	{
		sourceID: "nl-3dbag",
		jurisdiction: "nl",
		name: "3DBAG",
		publisher: "TU Delft 3D geoinformation research group and 3DGI",
		datasetURL: "https://3dbag.nl/download",
		detail: [StructureDetail.LoD1, StructureDetail.LoD2],
		formats: ["CityJSON", "GeoPackage", "OBJ", "3D Tiles"],
		license: "nl-3dbag",
		note: "LoD1.2, LoD1.3 and LoD2.2 with reconstructed roofs, for about 10 million buildings nationwide.",
	},
]

/**
 * The license decisions {@link NL_SOURCES} point at.
 */
export const NL_LICENSES: readonly LicenseDecision<StructureOperation>[] = [
	{
		licenseID: "nl-3dbag",
		state: LicenseReviewState.Unchecked,
		publisherStatement: "CC BY 4.0, per the 3DBAG download page.",
		note: RESEARCH_HANDOFF_NOTE,
	},
]
