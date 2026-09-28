/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream the address-containing features of a Geofabrik `.osm.pbf` extract to the per-country corpus jsonl the
 *   `@mailwoman/corpus` `osm` adapter reads.
 *
 *   ⚠ ODbL: the output is derived from OpenStreetMap and carries the share-alike obligation.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { dirname, type PathBuilderLike } from "path-ts"
import { createNewlineWriter } from "spliterator"

import { extractAddrPoints, type OSMAddrRecord } from "#sdk/extract"

/**
 * The corpus jsonl row: the extract's record with the house number under the `number` key the Overture rows
 * use.
 */
export interface OSMCorpusRow {
	street: string
	number: string
	postcode?: string
	suburb?: string
	city?: string
	unit?: string
	place?: string
	subdistrict?: string
	district?: string
	province?: string
	lat: number
	lon: number
}

export interface OSMCorpusJSONLStats {
	/**
	 * Every `addr:housenumber` feature the extract yielded.
	 */
	read: number
	/**
	 * Rows written: features that also carry an `addr:street`.
	 */
	written: number
	/**
	 * Features skipped for carrying no `addr:street`, the association gap.
	 */
	noStreet: number
}

/**
 * Project an extract record onto the corpus row, dropping the absent tags.
 */
export function toCorpusRow(record: OSMAddrRecord): OSMCorpusRow | null {
	if (record.street === null) return null

	const row: OSMCorpusRow = { street: record.street, number: record.housenumber, lat: record.lat, lon: record.lon }

	for (const key of ["postcode", "suburb", "city", "unit", "place", "subdistrict", "district", "province"] as const) {
		const value = record[key]

		if (value !== null) {
			row[key] = value
		}
	}

	return row
}

/**
 * Write the corpus jsonl for one extract.
 */
export async function writeOSMCorpusJSONL(pbfPath: string, outPath: PathBuilderLike): Promise<OSMCorpusJSONLStats> {
	await makeDirectories(dirname(outPath))

	await using out = createNewlineWriter(outPath)
	const stats: OSMCorpusJSONLStats = { read: 0, written: 0, noStreet: 0 }

	for await (const record of extractAddrPoints(pbfPath)) {
		stats.read++

		const row = toCorpusRow(record)

		if (!row) {
			stats.noStreet++

			continue
		}

		await out.write(stringifyJSON(row))

		stats.written++
	}

	return stats
}
