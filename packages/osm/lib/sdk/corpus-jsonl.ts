/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream the address-bearing features of a Geofabrik `.osm.pbf` extract to the per-country corpus JSONL the
 *   `@mailwoman/corpus` `osm` adapter reads. The split is the same one the Overture adapter rides: GDAL and the PBF
 *   stay here, and the corpus package, a runtime dependency of the `mailwoman` CLI, streams a light JSONL.
 *
 *   One row per `addr:housenumber` feature that also carries an `addr:street`. A point with no street is counted rather
 *   than written: a parser corpus row without a street teaches nothing the `wof-admin` rows do not already teach, and
 *   the rooftop builder sizes the same gap for the resolver. Every tag the extract projects rides along, absent ones
 *   omitted, plus the representative coordinate so a board can be drawn from the same file.
 *
 *   ⚠ ODbL: the OUTPUT is derived from OpenStreetMap and carries the share-alike obligation. The adapter stamps every
 *   row `ODbL-1.0`, which `SHARE_ALIKE_PATTERN` matches, so a proprietary-weights build passing `--exclude-share-alike`
 *   drops these rows at ingest and only the open weights learn from them.
 */

import { openWriteStream } from "@mailwoman/core/fs/streams"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { dirname, type PathBuilderLike } from "path-ts"

import { extractAddrPoints, type OSMAddrRecord } from "#sdk/extract"

/**
 * The corpus JSONL row: the extract's record with the house number under the `number` key the Overture rows use, so an
 * adapter reading either file meets the same shape.
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
	 * Features skipped for carrying no `addr:street` — the association gap.
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
 * Write the corpus JSONL for one extract. The output directory is created; an existing file is replaced.
 */
export async function writeOSMCorpusJSONL(pbfPath: string, outPath: PathBuilderLike): Promise<OSMCorpusJSONLStats> {
	await makeDirectories(dirname(outPath))

	const stream = openWriteStream(outPath, { encoding: "utf8" })
	const stats: OSMCorpusJSONLStats = { read: 0, written: 0, noStreet: 0 }

	try {
		for await (const record of extractAddrPoints(pbfPath)) {
			stats.read++

			const row = toCorpusRow(record)

			if (!row) {
				stats.noStreet++

				continue
			}

			if (!stream.write(JSON.stringify(row) + "\n")) {
				await new Promise<void>((resolve) => {
					stream.once("drain", resolve)
				})
			}

			stats.written++
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			stream.once("error", reject)
			stream.end(resolve)
		})
	}

	return stats
}
