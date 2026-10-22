/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structure sources published in Japan.
 */

import { LicenseReviewState, type LicenseDecision } from "@mailwoman/core/license/decision"

import { permittedByGrant } from "#grants"
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
	{
		sourceID: "jp-plateau-tokyo23ku",
		jurisdiction: "jp",
		region: "JP-13",
		municipality: "Tokyo 23 special wards",
		name: "PLATEAU 3D city model of the Tokyo 23 wards (product specification V2)",
		publisher: "Ministry of Land, Infrastructure, Transport and Tourism (MLIT), City Bureau",
		datasetURL: "https://www.geospatial.jp/ckan/dataset/plateau-tokyo23ku",
		detail: [StructureDetail.LoD1, StructureDetail.LoD2],
		formats: ["CityGML", "3D Tiles", "FBX", "OBJ"],
		license: "jp-plateau-tokyo23ku",
		attribution: "出典：国土交通省 PLATEAU（東京都23区 3D都市モデル）を加工して作成",
		attributionURL: "https://www.geospatial.jp/ckan/dataset/plateau-tokyo23ku",
		note: "The attribution reads: source, MLIT PLATEAU Tokyo 23 wards 3D city model, processed by the map's builder.",
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
	{
		licenseID: "jp-plateau-tokyo23ku",
		state: LicenseReviewState.Elected,
		electedTerms: "PLATEAU site policy, section 3 (Public Data License 1.0, with use under CC BY permitted)",
		retrievedCopy: "packages/structures/data/licenses/jp-plateau-tokyo23ku.md",
		retrievedAt: "2026-10-22",
		electedBecause:
			"The dataset's CKAN record names the PLATEAU site policy's copyright section as its license. That section " +
			"applies PDL 1.0 and permits use under CC BY. No SPDX identifier is recorded because PDL 1.0 has none.",
		operations: permittedByGrant({
			fetch: "The FAQ states that anyone may use the models freely at no cost.",
			convert: "The FAQ describes CityGML as an intermediate format to convert to other formats.",
			adapt:
				"The site policy permits editing and processing, stated separately from the source credit, " +
				"without presenting the result as MLIT's own.",
			redistribute: "The site policy permits use under CC BY, which grants sharing with attribution.",
			"commercial-sublicense": "The FAQ states that use includes commercial use.",
		}),
	},
]
