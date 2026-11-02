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
		license: "jp-plateau-site-policy",
		attribution: "出典：国土交通省 PLATEAU（東京都23区 3D都市モデル）を加工して作成",
		attributionURL: "https://www.geospatial.jp/ckan/dataset/plateau-tokyo23ku",
		note: "The attribution reads: source, MLIT PLATEAU Tokyo 23 wards 3D city model, processed by the map's builder.",
	},
	{
		sourceID: "jp-plateau-lod2-tilesets",
		jurisdiction: "jp",
		name: "PLATEAU untextured LoD2 building tilesets hosted by PLATEAU VIEW",
		publisher: "Ministry of Land, Infrastructure, Transport and Tourism (MLIT), City Bureau",
		datasetURL: "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets",
		detail: [StructureDetail.LoD2],
		formats: ["3D Tiles"],
		license: "jp-plateau-site-policy",
		attribution: "出典：国土交通省 PLATEAU（3D都市モデル）を加工して作成",
		attributionURL: "https://www.mlit.go.jp/plateau/site-policy/",
		note:
			"data/plateau-tilesets.json lists each tileset with the license_title of its CKAN dataset, and a map draws " +
			"only the ones whose title is the site policy. sdk/plateau-tilesets.run.ts regenerates the list.",
	},
	{
		sourceID: "jp-estat-small-area",
		jurisdiction: "jp",
		name: "2020 census small-area (町丁・字等) boundary data",
		publisher: "Statistics Bureau of Japan, through the e-Stat portal run by the National Statistics Center",
		datasetURL:
			"https://www.e-stat.go.jp/gis/statmap-search?page=1&type=2&aggregateUnitForBoundary=A&toukeiCode=00200521&toukeiYear=2020",
		detail: [StructureDetail.District],
		formats: ["Shapefile", "GML", "KML"],
		license: "jp-estat",
		attribution:
			"出典：政府統計の総合窓口(e-Stat)（https://www.e-stat.go.jp/）、「令和2年国勢調査 小地域（町丁・字等）境界データ」（総務省統計局）を加工して作成",
		attributionURL: "https://www.e-stat.go.jp/terms-of-use",
		note:
			"The boundaries are a 2020 census snapshot, published every five years. The 2025 census boundaries were " +
			"not offered when the terms were read. The download page states that the boundaries were made for " +
			"statistical work and do not always match administrative areas.",
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
		licenseID: "jp-plateau-site-policy",
		state: LicenseReviewState.Elected,
		electedTerms: "PLATEAU site policy, section 3 (Public Data License 1.0, with use under CC BY permitted)",
		retrievedCopy: "packages/structures/data/licenses/jp-plateau-tokyo23ku.md",
		retrievedAt: "2026-10-22",
		electedBecause:
			"The CKAN record of each dataset that points here names the PLATEAU site policy's copyright section as its " +
			"license: plateau-tokyo23ku, the 22 Tokyo ward 2025 records in " +
			"packages/structures/data/licenses/jp-plateau-tokyo-wards-2025.md, and each tileset in " +
			"packages/structures/data/plateau-tilesets.json whose licenseTitle reads so. That section applies PDL 1.0 " +
			"and permits use under CC BY. PDL 1.0 has no SPDX identifier, so `spdx` stays unset.",
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
	{
		licenseID: "jp-estat",
		state: LicenseReviewState.Elected,
		electedTerms:
			"政府統計の総合窓口（e-Stat）利用規約, which follows the Government Standard Terms of Use version 2.0",
		retrievedCopy: "packages/structures/data/licenses/jp-estat.md",
		retrievedAt: "2026-11-02",
		electedBecause:
			"The statistical GIS terms, article 6, apply the main e-Stat terms to the content the GIS offers, which " +
			"includes the boundary data. Those terms let anyone reproduce, transmit publicly and adapt the content, " +
			"and permit commercial use, with a source credit and a separate note that the data was processed. " +
			"They also state compatibility with CC BY 4.0. The terms have no SPDX identifier, so `spdx` stays unset.",
		operations: permittedByGrant({
			fetch: "「どなたでも…複製…自由に利用できます。」",
			convert: "「翻訳・変形等の翻案等、自由に利用できます。」",
			adapt:
				"「コンテンツを編集・加工等して利用する場合は、上記出典とは別に、編集・加工等を行ったことを記載してください。」",
			redistribute: "「複製、公衆送信…自由に利用できます。」",
			"commercial-sublicense": "「商用利用も可能です。」",
		}),
	},
]
