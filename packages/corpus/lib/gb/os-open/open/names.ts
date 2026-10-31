/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the road rows of OS Open Names.
 *
 *   The CSV product is 819 files, one per 10 km National Grid square, with no header row. OS ships
 *   the 34 column names in `Doc/OS_Open_Names_Header.csv`. The first data row of each file opens
 *   with a byte-order mark. This reader strips that mark from the `ID` value.
 *
 *   A road row's `ID` is the roadNameTOID that OS Open Roads links reference, such as
 *   `osgb4000000010927776`. The road-specific `LOCAL_TYPE` values distinguish a complete road from
 *   a section split at a postcode district or settlement.
 */

import { CSVSpliterator } from "spliterator"

/**
 * The 34 columns of an OS Open Names CSV, in file order, as `Doc/OS_Open_Names_Header.csv` names them.
 */
export const OPEN_NAMES_COLUMNS = [
	"ID",
	"NAMES_URI",
	"NAME1",
	"NAME1_LANG",
	"NAME2",
	"NAME2_LANG",
	"TYPE",
	"LOCAL_TYPE",
	"GEOMETRY_X",
	"GEOMETRY_Y",
	"MOST_DETAIL_VIEW_RES",
	"LEAST_DETAIL_VIEW_RES",
	"MBR_XMIN",
	"MBR_YMIN",
	"MBR_XMAX",
	"MBR_YMAX",
	"POSTCODE_DISTRICT",
	"POSTCODE_DISTRICT_URI",
	"POPULATED_PLACE",
	"POPULATED_PLACE_URI",
	"POPULATED_PLACE_TYPE",
	"DISTRICT_BOROUGH",
	"DISTRICT_BOROUGH_URI",
	"DISTRICT_BOROUGH_TYPE",
	"COUNTY_UNITARY",
	"COUNTY_UNITARY_URI",
	"COUNTY_UNITARY_TYPE",
	"REGION",
	"REGION_URI",
	"COUNTRY",
	"COUNTRY_URI",
	"RELATED_SPATIAL_OBJECT",
	"SAME_AS_DBPEDIA",
	"SAME_AS_GEONAMES",
] as const

const column = Object.fromEntries(OPEN_NAMES_COLUMNS.map((name, index) => [name, index])) as Record<
	(typeof OPEN_NAMES_COLUMNS)[number],
	number
>

/**
 * The `LOCAL_TYPE` values that mark a road row.
 */
export const OPEN_NAMES_ROAD_TYPES: ReadonlySet<string> = new Set(["Named Road", "Section Of Named Road"])

/**
 * One road row of OS Open Names, with the columns the corpus adapter reads.
 */
export interface OpenNamesRoad {
	/**
	 * The roadNameTOID, such as `osgb4000000010927776`.
	 */
	id: string
	/**
	 * The road's name, in the language OS lists first.
	 */
	name1: string
	/**
	 * The road's other-language name, Welsh or Gaelic, or an empty string.
	 */
	name2: string
	/**
	 * The outward code of the postcode district holding the road, such as `LS6`.
	 */
	postcodeDistrict: string
	/**
	 * The settlement holding the road, or an empty string.
	 *
	 * A bilingual settlement is written `<NAME1> / <NAME2>` of that settlement,
	 * such as `Stornoway / Steòrnabhagh`.
	 */
	populatedPlace: string
	districtBorough: string
	countyUnitary: string
}

/**
 * Counts from a read, with a reason for each row that did not yield.
 */
export interface OpenNamesReadStats {
	/**
	 * Rows read across every file.
	 */
	read: number
	/**
	 * Road rows yielded.
	 */
	roads: number
	/**
	 * Road rows skipped because their `ID` was not among the requested ids.
	 */
	unrequested: number
	/**
	 * Rows with a column count other than 34.
	 */
	malformed: number
}

/**
 * A stats object with every count at zero.
 */
export function createOpenNamesReadStats(): OpenNamesReadStats {
	return { read: 0, roads: 0, unrequested: 0, malformed: 0 }
}

/**
 * Streams the road rows of one Open Names CSV.
 *
 * @param ids When given, only roads whose `ID` is in the set are yielded.
 */
export async function* readOpenNamesRoads(
	csvPath: string,
	stats: OpenNamesReadStats,
	ids?: ReadonlySet<string>
): AsyncGenerator<OpenNamesRoad> {
	for await (const row of CSVSpliterator.fromAsync<string[]>(csvPath, { header: false })) {
		stats.read++

		if (row.length !== OPEN_NAMES_COLUMNS.length) {
			stats.malformed++

			continue
		}

		if (!OPEN_NAMES_ROAD_TYPES.has(row[column.LOCAL_TYPE]!)) continue

		const id = row[column.ID]!.replace(/^﻿/u, "")

		if (ids && !ids.has(id)) {
			stats.unrequested++

			continue
		}

		stats.roads++

		yield {
			id,
			name1: row[column.NAME1]!.trim(),
			name2: row[column.NAME2]!.trim(),
			postcodeDistrict: row[column.POSTCODE_DISTRICT]!.trim(),
			populatedPlace: row[column.POPULATED_PLACE]!.trim(),
			districtBorough: row[column.DISTRICT_BOROUGH]!.trim(),
			countyUnitary: row[column.COUNTY_UNITARY]!.trim(),
		}
	}
}

/**
 * The `LOCAL_TYPE` of the one Open Names entry OS publishes for each unit postcode.
 */
const OPEN_NAMES_POSTCODE_TYPE = "Postcode"

/**
 * One unit postcode of OS Open Names with the county or unitary authority holding it.
 */
export interface OpenNamesPostcodeCounty {
	/**
	 * The postcode as OS writes it in `NAME1`, such as `ME14 1JH`.
	 */
	postcode: string
	/**
	 * The `COUNTY_UNITARY` name, such as `Kent`, or an empty string where OS records none.
	 */
	countyUnitary: string
}

/**
 * Streams the unit-postcode rows of one Open Names CSV with their county or unitary authority.
 */
export async function* readOpenNamesPostcodeCounties(
	csvPath: string,
	stats: OpenNamesReadStats
): AsyncGenerator<OpenNamesPostcodeCounty> {
	for await (const row of CSVSpliterator.fromAsync<string[]>(csvPath, { header: false })) {
		stats.read++

		if (row.length !== OPEN_NAMES_COLUMNS.length) {
			stats.malformed++

			continue
		}

		if (row[column.LOCAL_TYPE] !== OPEN_NAMES_POSTCODE_TYPE) continue

		yield { postcode: row[column.NAME1]!.trim(), countyUnitary: row[column.COUNTY_UNITARY]!.trim() }
	}
}

/**
 * The settlement's first-listed name from a `POPULATED_PLACE` value.
 *
 * OS writes a bilingual settlement as `<NAME1> / <NAME2>`, and NAME1 is the form the adapter emits.
 */
export function populatedPlaceName1(populatedPlace: string): string {
	return populatedPlace.split(" / ")[0]!.trim()
}
