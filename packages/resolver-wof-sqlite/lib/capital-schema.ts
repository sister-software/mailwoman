/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `capital` table (#1880's distribution home): the capital-status reference carried INSIDE
 *   `candidate.db`, so an npm consumer who pulled the artifact can run `capital_tier` without the
 *   repo's `data/gazetteer/capitals-v1.json` — which published packages do not ship. One row per
 *   reference entry (241 national capitals + 3,463 admin-1 seats at the 2026-08-24 build); the
 *   loader reads the WHOLE table once into a `CapitalIndex` at session construction, so there is no
 *   per-probe query and no index beyond the rowid.
 *
 *   `keys` holds the entry's folded name set as a JSON array — the name-membership conjunct that
 *   keeps the coordinate radius from promoting a capital's same-name neighbours (`capitals.ts`).
 */

import { tryParsingJSON } from "@mailwoman/core/objects"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { Kysely } from "kysely"

import type { CapitalPoint } from "#capitals"
import { hasTable } from "#sqlite-utils"

/**
 * The table name the builder writes and the reader probes — one word, singular, matching the artifact's other reference
 * tables (`candidate`, `country_codes`).
 */
export const CAPITAL_TABLE = "capital"

/**
 * One reference entry as the artifact stores it. `level` is the reference vocabulary (`national` | `admin1`) kept as
 * text — the reader validates on load rather than trusting bytes.
 */
export interface CapitalTable {
	country: string
	latitude: number
	longitude: number
	level: string
	/**
	 * JSON array of folded name keys (name + romanization + alternates).
	 */
	keys: string
}

/**
 * Create the table on a build in progress. Async because Kysely's schema-builder is; called from the candidate build's
 * DDL phase alongside the other typed builders.
 */
export async function createCapitalTable<DB extends { capital: CapitalTable }>(db: Kysely<DB>): Promise<void> {
	await db.schema
		.createTable(CAPITAL_TABLE)
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("latitude", "real", (c) => c.notNull())
		.addColumn("longitude", "real", (c) => c.notNull())
		.addColumn("level", "text", (c) => c.notNull())
		.addColumn("keys", "text", (c) => c.notNull())
		.execute()
}

/**
 * Read the whole reference out of an artifact, or `null` when the artifact predates the table — the caller then falls
 * back to its next source rather than treating an old artifact as "no capitals" (the meaning-of-zero rule: a missing
 * table is UNMEASURED, an empty one is a finding).
 */
export function readCapitalPoints<DB>(db: DatabaseClient<DB>): CapitalPoint[] | null {
	if (!hasTable(db, CAPITAL_TABLE)) return null

	const points: CapitalPoint[] = []

	for (const row of db.prepare(`SELECT country, latitude, longitude, level, keys FROM ${CAPITAL_TABLE}`).iterate()) {
		const level = String(row.level)

		if (level !== "national" && level !== "admin1") continue

		const keys = tryParsingJSON<string[]>(String(row.keys))

		if (!Array.isArray(keys)) continue

		points.push({
			country: String(row.country),
			latitude: Number(row.latitude),
			longitude: Number(row.longitude),
			level,
			k: keys,
		})
	}

	return points
}
