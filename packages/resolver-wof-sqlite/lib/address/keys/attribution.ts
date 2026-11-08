// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
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
}

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

	const entries = tallies
		.map((row): AddressLayerAttribution => {
			const source = sources.get(row.source_id)

			if (!source) throw new Error(`${files.detail} holds rows of source ${row.source_id}, which lookup.db lacks`)

			return {
				source: source.name,
				authority: row.authority,
				records: Number(row.records),
				license: source.license,
				recorded: recorded.get(source.name) ?? null,
			}
		})
		.toSorted((left, right) => right.records - left.records)

	const path = resolvePathBuilder(dirname(files.lookup), "ATTRIBUTION.json")

	await writeLocalJSONFile(entries, path)

	return { path, entries }
}
