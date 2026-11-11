/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the `ATTRIBUTION.json` that sits beside a built address-layer region's files.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"
import { dirname, resolvePathBuilder, type PathBuilder, type PathBuilderLike } from "path-ts"

import { addressLayerFiles } from "#address/keys/layout"
import type { AddressDetailDatabase, AddressLookupDatabase } from "#address/keys/schema"

/**
 * One source and authority of a region's rows, with the terms the source records.
 */
export interface AddressLayerAttribution {
	/**
	 * The wire source id, such as `usgov-nad` or `openaddresses:us/wi/statewide`.
	 */
	source: string
	/**
	 * The authority a row states, such as NAD's `AddAuth`, or `null` when its rows state none.
	 */
	authority: string | null
	records: number
	/**
	 * The license expression `lookup.db`'s `source` table holds, or `null`
	 * when the source's terms are unread.
	 */
	license: string | null
	/**
	 * The terms as the source's definition records them, such as an OpenAddresses run's
	 * `license` object, or `null` when the caller has no definition for the source.
	 */
	recorded: unknown
	/**
	 * The distinct values this source's rows state as their authority, when those values
	 * identify records rather than authorities (see {@linkcode AUTHORITY_RECORD_ID_SHARE})
	 * and so are left out of this entry.
	 * Absent when the source's authorities are kept.
	 */
	omittedAuthorities?: number
}

/**
 * The share of a source's rows that may each state an authority value no other row shares
 * before the source's authority values are read as record identifiers.
 *
 * An authority is a body that maintains a whole area's addresses, so a source's
 * rows share a few authority values.
 * In NAD release 24, every state but one holds at most one distinct `AddAuth` value per 5,000 rows.
 *
 * Idaho holds 78,956 distinct values across 79,656 rows: its provider wrote each record's id into the field.
 */
export const AUTHORITY_RECORD_ID_SHARE = 0.5

/**
 * Writes `ATTRIBUTION.json` beside a built region's `lookup.db`, one entry per source
 * and authority, largest first.
 *
 * Row counts come from `detail.db`, and each license from `lookup.db`'s `source` table.
 *
 * @param recorded The terms each source's definition records, keyed by source id.
 */
export async function writeAddressLayerAttribution(
	root: PathBuilderLike,
	region: string,
	version: string,
	recorded: ReadonlyMap<string, unknown> = new Map()
): Promise<{ path: PathBuilder; entries: AddressLayerAttribution[] }> {
	const files = addressLayerFiles(root, region, version)

	using lookup = new DatabaseClient<AddressLookupDatabase>(files.lookup, { readOnly: true })
	using detail = new DatabaseClient<AddressDetailDatabase>(files.detail, { readOnly: true })

	const sources = new Map(
		(await lookup.selectFrom("source").select(["source_id", "name", "license"]).execute()).map((row) => [
			row.source_id,
			row,
		])
	)

	const tallies = await detail
		.selectFrom("address")
		.select(["source_id", "authority", sql<number>`count(*)`.as("records")])
		.groupBy(["source_id", "authority"])
		.execute()

	const bySource = Map.groupBy(tallies, (row) => row.source_id)

	const entries = [...bySource]
		.flatMap(([sourceID, rows]): AddressLayerAttribution[] => {
			const source = sources.get(sourceID)

			if (!source) throw new Error(`${files.detail} holds rows of source ${sourceID}, which lookup.db lacks`)

			const base = { source: source.name, license: source.license, recorded: recorded.get(source.name) ?? null }
			const records = rows.reduce((sum, row) => sum + Number(row.records), 0)
			const authorities = rows.filter((row) => row.authority != null).length
			const singletons = rows.filter((row) => row.authority != null && Number(row.records) === 1).length

			// A source most of whose rows each state an authority value no other row shares is stating record ids there.
			if (authorities > 1 && singletons > records * AUTHORITY_RECORD_ID_SHARE) {
				return [{ ...base, authority: null, records, omittedAuthorities: authorities }]
			}

			return rows.map((row) => ({ ...base, authority: row.authority, records: Number(row.records) }))
		})
		.toSorted((left, right) => right.records - left.records)

	const path = resolvePathBuilder(dirname(files.lookup), "ATTRIBUTION.json")

	await writeLocalJSONFile(entries, path)

	return { path, entries }
}
