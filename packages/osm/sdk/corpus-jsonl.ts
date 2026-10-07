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
	 * `addr:street`, null on a streetless record.
	 *
	 * The `osm` corpus adapter decides whether a streetless record is an address.
	 */
	street: string | null
	number: string
	postcode: string | null
	suburb: string | null
	city: string | null
	unit: string | null
	place: string | null
	subdistrict: string | null
	district: string | null
	province: string | null
	/**
	 * `addr:country`, where the mapper tagged one.
	 */
	country: string | null
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
 * Project an extract record onto the corpus row.
 */
export function toCorpusRow(record: OSMAddrRecord): OSMCorpusRow {
	return {
		street: record.street,
		number: record.housenumber,
		postcode: record.postcode,
		suburb: record.suburb,
		city: record.city,
		unit: record.unit,
		place: record.place,
		subdistrict: record.subdistrict,
		district: record.district,
		province: record.province,
		country: record.country,
		lat: record.lat,
		lon: record.lon,
	}
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

		if (!record.street) {
			stats.noStreet++
		}

		await out.write(stringifyJSON(toCorpusRow(record)))

		stats.written++
	}

	return stats
}
