/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Samples rows of an `address_point` table by random rowid probe.
 *
 *   France's BAN extract and each US state's situs database share the table, so the sampler is shared and each
 *   country's tuple module supplies the path and the rendering. The draws are the Python sampler's
 *   (`corpora/address_points.py`): one `randrange(1, MAX(rowid) + 1)` per probe from the caller's generator.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address/point/schema"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"
import { sql } from "kysely"
import type { PathBuilderLike } from "path-ts"

import type { PyRandom } from "#training/pyrandom"

/**
 * A row as the table stores it: street, number, postcode, locality.
 */
export type AddressPoint = readonly [street: string, number: string, postcode: string, locality: string]

/**
 * Probes per requested row before the sampler stops.
 * A rowid range is sparse after deletes, so some probes miss.
 */
export const ADDRESS_POINT_PROBE_BUDGET = 8

/**
 * Options for {@linkcode sampleAddressPoints}.
 */
export interface SampleAddressPointsOptions {
	/**
	 * Keeps only rows whose `source` column is one of these.
	 *
	 * A probe that lands on another source's row counts against the budget.
	 */
	sources?: ReadonlySet<string>
	/**
	 * @defaultValue {@linkcode ADDRESS_POINT_PROBE_BUDGET}
	 */
	probeBudget?: number
}

interface ProbedRow {
	street_norm: string | null
	number: string | null
	postcode: string | null
	locality_norm: string | null
	source: string | null
}

/**
 * Up to `count` rows, each with all four fields, in probe order.
 *
 * `ORDER BY RANDOM()` scans the whole table, so the sample is drawn by rowid probe.
 * A row missing a field is skipped.
 *
 * @throws When `path` does not exist, naming it.
 */
export async function sampleAddressPoints(
	path: PathBuilderLike,
	count: number,
	rng: PyRandom,
	options: SampleAddressPointsOptions = {}
): Promise<AddressPoint[]> {
	if (!(await pathExists(path))) throw new Error(`No address-point database at ${path.toString()}`)

	using db = await openBuiltClient<AddressPointDatabase>(path)

	const { max } = await db
		.selectFrom("address_point")
		.select(sql<number | null>`max(rowid)`.as("max"))
		.executeTakeFirstOrThrow()

	if (!max) return []

	// The probe is the sampler's throughput path, so it runs as one prepared statement.
	const probe = db.prepare(
		"SELECT street_norm, number, postcode, locality_norm, source FROM address_point WHERE rowid = ?"
	)

	const budget = count * (options.probeBudget ?? ADDRESS_POINT_PROBE_BUDGET)
	const rows: AddressPoint[] = []
	const seen = new Set<number>()

	for (let attempts = 0; rows.length < count && attempts < budget; attempts++) {
		const rowid = rng.randrange(1, max + 1)

		if (seen.has(rowid)) continue

		seen.add(rowid)

		const row = probe.get(rowid) as ProbedRow | undefined

		if (!row) continue

		if (options.sources && !options.sources.has(row.source!)) continue

		if (row.street_norm && row.number && row.postcode && row.locality_norm) {
			rows.push([row.street_norm, row.number, row.postcode, row.locality_norm])
		}
	}

	return rows
}
