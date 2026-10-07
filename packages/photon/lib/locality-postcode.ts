/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reverse lookup over the `postcode-locality-*.db` artifacts: the containing postcode of a
 *   resolved locality, keyed by its WOF id.
 *
 *   The exactly-one rule is the abstention: a locality contained by several postcodes (any real city) gets
 *   no postcode. A machine without the DBs degrades to no enrichment.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PostcodeLocalityDatabase } from "mailwoman/locality-postcode-schema"

/**
 * The per-country artifacts, probed in caller-country order with `intl` as the shared fallback.
 */
const POSTCODE_LOCALITY_SUFFIXES = ["fr", "de", "jp", "intl"] as const

export type LocalityPostcodeLookup = (wofID: number, countryCode: string | null) => string | null

export async function createLocalityPostcodeLookup(): Promise<LocalityPostcodeLookup> {
	const statements = new Map<string, ReturnType<DatabaseClient["prepare"]>>()

	for (const suffix of POSTCODE_LOCALITY_SUFFIXES) {
		const path = wofDatabasePath(`postcode-locality-${suffix}.db`)

		if (!(await pathExists(path))) continue

		try {
			const db = new DatabaseClient<PostcodeLocalityDatabase>(path, { readOnly: true })

			// No `is_containing` filter: villages routinely have 0, so the exactly-one
			// distinct rule below is the entire ambiguity guard.
			statements.set(
				suffix,
				db.prepare(`SELECT DISTINCT postcode FROM postcode_locality WHERE locality_id = ? LIMIT 2`)
			)
		} catch {
			// A torn or foreign file degrades to no enrichment, never a crash at serve start.
		}
	}

	return (wofID, countryCode) => {
		const cc = countryCode?.toLowerCase()
		const order = cc && statements.has(cc) ? [cc, "intl"] : ["intl"]

		for (const suffix of order) {
			const stmt = statements.get(suffix)

			if (!stmt) continue

			const rows = stmt.all(wofID) as Array<{ postcode: string }>

			if (rows.length === 1) return rows[0]!.postcode

			if (rows.length > 1) return null // ambiguous — abstain, never guess
		}

		return null
	}
}
