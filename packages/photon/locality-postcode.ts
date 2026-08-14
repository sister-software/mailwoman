/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reverse lookup over the `postcode-locality-*.db` artifacts: the CONTAINING postcode of a
 *   resolved locality, keyed by its WOF id — no name matching. Serves the drop-ins' answer
 *   enrichment: a village answer carries the postcode the gazetteer attests for it.
 *
 *   The exactly-one rule is the abstention: a locality contained by several postcodes (any real
 *   city) gets NOTHING — emitting one of many would state a precision the evidence doesn't hold.
 *   Tolerate-and-degrade like every optional artifact: a machine without the DBs answers undefined
 *   everywhere and the consumer simply doesn't decorate.
 */

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"

/**
 * The per-country artifacts, probed in caller-country order with `intl` as the shared fallback.
 */
const POSTCODE_LOCALITY_SUFFIXES = ["fr", "de", "jp", "intl"] as const

export type LocalityPostcodeLookup = (wofID: number, countryCode: string | null) => string | undefined

export function createLocalityPostcodeLookup(): LocalityPostcodeLookup {
	const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>()

	for (const suffix of POSTCODE_LOCALITY_SUFFIXES) {
		const path = String(dataRootPath("wof", `postcode-locality-${suffix}.db`))

		if (!existsSync(path)) continue

		try {
			const db = new DatabaseSync(path, { readOnly: true })

			// No `is_containing` filter: villages routinely carry 0 (the builder's containment test is
			// distance-classified, and a village near its postcode centroid still has exactly one code).
			// The exactly-one DISTINCT rule below is the entire ambiguity guard.
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

			if (rows.length > 1) return undefined // ambiguous — abstain, never guess
		}

		return undefined
	}
}
