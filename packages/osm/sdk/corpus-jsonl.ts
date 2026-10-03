/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream the address-containing features of a Geofabrik `.osm.pbf` extract to the per-country corpus jsonl the
 *   `@mailwoman/corpus` `osm` adapter reads.
 *
 *   ⚠ ODbL: the output is derived from OpenStreetMap and has the share-alike obligation.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { dirname, type PathBuilderLike } from "path-ts"
import { createNewlineWriter } from "spliterator"

import { extractAddrPoints, type OSMAddrRecord, type OSMExtractTally } from "#sdk/extract"

/**
 * The corpus jsonl row: the extract's record with the house number under the
 * `number` key the Overture rows use.
 */
export interface OSMCorpusRow {
	/**
	 * `addr:street`, absent on a streetless record.
	 *
	 * The `osm` corpus adapter decides whether a streetless record is an address.
	 */
	street?: string
	number: string
	postcode?: string
	suburb?: string
	city?: string
	unit?: string
	place?: string
	subdistrict?: string
	district?: string
	province?: string
	/**
	 * `addr:country`, where the mapper tagged one.
	 */
	country?: string
	lat: number
	lon: number
}

export interface OSMCorpusJSONLStats {
	/**
	 * Every `addr:housenumber` feature the extract yielded.
	 */
	read: number
	/**
	 * Rows written: every feature the extract yielded, less those outside the country outline.
	 */
	written: number
	/**
	 * Features whose point lies outside the country outline, or `null` when no outline was given.
	 */
	outsideOutline: number | null
	/**
	 * Rows written without an `addr:street`.
	 * They are a subset of `written`.
	 */
	noStreet: number
	/**
	 * Per-layer counts of the features the driver matched and the extract discarded before yielding.
	 */
	extract: OSMExtractTally
}

/**
 * Project an extract record onto the corpus row, dropping the absent tags.
 */
export function toCorpusRow(record: OSMAddrRecord): OSMCorpusRow {
	const row: OSMCorpusRow = { number: record.housenumber, lat: record.lat, lon: record.lon }

	for (const key of [
		"street",
		"postcode",
		"suburb",
		"city",
		"unit",
		"place",
		"subdistrict",
		"district",
		"province",
		"country",
	] as const) {
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
export async function writeOSMCorpusJSONL(
	pbfPath: string,
	outPath: PathBuilderLike,
	opts: { within?: (lon: number, lat: number) => boolean } = {}
): Promise<OSMCorpusJSONLStats> {
	await makeDirectories(dirname(outPath))

	await using out = createNewlineWriter(outPath)

	const stats: OSMCorpusJSONLStats = {
		read: 0,
		written: 0,
		noStreet: 0,
		outsideOutline: opts.within ? 0 : null,
		extract: {},
	}

	for await (const record of extractAddrPoints(pbfPath, stats.extract)) {
		stats.read++

		if (opts.within && !opts.within(record.lon, record.lat)) {
			stats.outsideOutline!++

			continue
		}

		if (record.street === null) {
			stats.noStreet++
		}

		await out.write(stringifyJSON(toCorpusRow(record)))

		stats.written++
	}

	return stats
}
