/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structure sources published in Japan.
 */

import { LicenseReviewState, type LicenseDecision } from "@mailwoman/core/license/decision"

import { RESEARCH_HANDOFF_NOTE } from "#research"
import { StructureDetail, type StructureOperation, type StructureSource } from "#types"

/**
 * Japan's structure sources, from the 2026-10-22 landmark-data research handoff.
 */
export const JP_SOURCES: readonly StructureSource[] = [
	{
		sourceID: "jp-plateau",
		jurisdiction: "jp",
		name: "Project PLATEAU 3D city models",
		publisher: "Ministry of Land, Infrastructure, Transport and Tourism (MLIT)",
		datasetURL: "https://www.geospatial.jp/ckan/dataset/plateau",
		detail: [StructureDetail.LoD1, StructureDetail.LoD2, StructureDetail.LoD3],
		formats: ["CityGML", "3D Tiles", "MVT", "OBJ", "FBX"],
		license: "jp-plateau",
		note:
			"Each municipality publishes its own PLATEAU datasets, and coverage, LoD and license vary by dataset. " +
			"A decision per municipal dataset replaces this one before any PLATEAU geometry ships.",
	},
]

/**
 * The license decisions {@link JP_SOURCES} point at.
 */
export const JP_LICENSES: readonly LicenseDecision<StructureOperation>[] = [
	{
		licenseID: "jp-plateau",
		state: LicenseReviewState.Unchecked,
		publisherStatement:
			"The PLATEAU FAQ permits commercial use. Datasets carry CC BY 4.0, Public Data License 1.0, ODC-By or ODbL " +
			"depending on the dataset.",
		note: RESEARCH_HANDOFF_NOTE,
	},
]
