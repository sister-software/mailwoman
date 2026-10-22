/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structure sources published in Switzerland.
 */

import { LicenseReviewState, type LicenseDecision } from "@mailwoman/core/license/decision"

import { RESEARCH_HANDOFF_NOTE } from "#research"
import { StructureDetail, type StructureOperation, type StructureSource } from "#types"

/**
 * Switzerland's structure sources, from the 2026-10-22 landmark-data research handoff.
 */
export const CH_SOURCES: readonly StructureSource[] = [
	{
		sourceID: "ch-swissbuildings3d",
		jurisdiction: "ch",
		name: "swissBUILDINGS3D 3.0",
		publisher: "Federal Office of Topography swisstopo",
		datasetURL: "https://opendata.swiss/en/dataset/swissbuildings3d-3-0-beta",
		detail: [StructureDetail.LoD2],
		formats: ["CityGML", "DXF", "GDB"],
		license: "ch-swisstopo-ogd",
		note: "The dataset description states coverage of Switzerland and Liechtenstein.",
	},
]

/**
 * The license decisions {@link CH_SOURCES} point at.
 */
export const CH_LICENSES: readonly LicenseDecision<StructureOperation>[] = [
	{
		licenseID: "ch-swisstopo-ogd",
		state: LicenseReviewState.Unchecked,
		publisherStatement:
			"swisstopo's Open Government Data terms: free basic geodata may be used commercially without authorization, " +
			"and source attribution such as `© swisstopo` is mandatory.",
		note: RESEARCH_HANDOFF_NOTE,
	},
]
