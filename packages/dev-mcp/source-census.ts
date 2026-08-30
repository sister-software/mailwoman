/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   WHAT DATA DO WE ACTUALLY HOLD, per country, per artifact.
 *
 *   `lookup-sources.ts` answers "does this source know this string". This answers the question that comes BEFORE it —
 *   is there anything here for this country at all, in which file, and can it be joined to anything. Every locale
 *   expansion starts with it, and it was hand-rolled four separate times in one session before landing here.
 *
 *   The columns are chosen from what those hand-rolls kept having to re-discover:
 *
 *   - **`join`** — a postcode shard with rows and no `ancestors` table cannot yield a (postcode, locality, region)
 *     triple, so a row count alone is a misleading yes. `postalcode-geonames-intl.db` holds 395,544 PT postcodes and
 *     is `spr`-only; `postalcode-intl.db` holds 27,119 FR and has the ancestry tables. Same verb, different answer.
 *   - **`parentLinked`** — and even an `ancestors` table is not enough on its own. Measured on `postalcode-intl.db`:
 *     `parent_id` is `-1` on EVERY postcode row, and the ancestry chain for `75002` is a single SELF-reference at
 *     placetype `postalcode`. So neither column reaches a locality, and a builder that assumes either produces zero
 *     rows and reads as a coverage gap.
 *   - **`bytes` / `tables`** — a zero-byte or table-less shard is a real on-disk state (see #1791), and it looks
 *     identical to "this country has no data" from a row count.
 *
 *   ABSENCE IS REPORTED, NOT OMITTED. A country asked for and not found gets a row saying so, because "the query
 *   returned nothing" and "we never looked there" are the two facts this file exists to keep apart.
 */

import { pathExists, readDirectory } from "@mailwoman/core/fs/readers"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { existsSync, statSync } from "@mailwoman/platform/fs"
import { join } from "@mailwoman/platform/path"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

/**
 * What a shard can be joined THROUGH, which decides what a corpus builder can extract from it.
 *
 * `ancestry` does not promise the chain reaches a locality — only that the table exists. The header records why that
 * distinction cost a measurement.
 */
export type JoinCapability = "ancestry" | "names" | "search" | "population"

const JOIN_TABLES: ReadonlyArray<[JoinCapability, string]> = [
	["ancestry", "ancestors"],
	["names", "names"],
	["search", "place_search"],
	["population", "place_population"],
]

/**
 * One artifact's census.
 */
export interface SourceCensusRow {
	artifact: string
	bytes: number
	tables: number
	/**
	 * Present only when the artifact carries an `spr` table — the shape every gazetteer shard shares. A file without one
	 * is reported with `readable: false` and a reason rather than a zero.
	 */
	countries?: Record<string, number>
	join: JoinCapability[]
	/**
	 * Whether ANY row carries a usable `parent_id`. A shard whose every row reads `-1` cannot be walked upward, and that
	 * is invisible from a row count.
	 */
	parentLinked?: boolean
	readable: boolean
	reason?: string
}

function tableNames(db: DatabaseClient<WOFDatabase>): string[] {
	return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
		(row) => row.name
	)
}

/**
 * Census one SQLite artifact. Never throws — an unreadable file is a finding, not an error.
 */
export function censusArtifact(path: string, countries?: readonly string[]): SourceCensusRow {
	const artifact = path.split("/").pop() ?? path

	if (!existsSync(path)) {
		return { artifact, bytes: 0, tables: 0, join: [], readable: false, reason: "not on disk" }
	}

	const bytes = statSync(path).size

	let db: DatabaseClient<WOFDatabase>

	try {
		db = new DatabaseClient<WOFDatabase>(path, { readOnly: true })
	} catch (error) {
		return { artifact, bytes, tables: 0, join: [], readable: false, reason: (error as Error).message.slice(0, 120) }
	}

	try {
		const tables = tableNames(db)
		const joins = JOIN_TABLES.filter(([, table]) => tables.includes(table)).map(([capability]) => capability)

		if (!tables.includes("spr")) {
			return {
				artifact,
				bytes,
				tables: tables.length,
				join: joins,
				readable: false,
				reason:
					bytes === 0 ? "zero bytes — no tables at all" : `no \`spr\` table (has: ${tables.slice(0, 5).join(", ")})`,
			}
		}

		const rows = db.prepare("SELECT country, COUNT(*) AS n FROM spr GROUP BY country").all() as Array<{
			country: string | null
			n: number
		}>

		const counts: Record<string, number> = {}

		for (const row of rows) {
			const code = (row.country ?? "").toUpperCase()

			if (!code) continue

			if (countries && !countries.includes(code)) continue

			counts[code] = row.n
		}

		// Asked for and absent is a REPORTED zero, never a missing key — the caller is deciding whether to acquire data.
		if (countries) {
			for (const code of countries) {
				counts[code] ??= 0
			}
		}

		const linked = db.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM spr WHERE parent_id > 0 LIMIT 1)").get() as {
			n: number
		}

		return {
			artifact,
			bytes,
			tables: tables.length,
			countries: counts,
			join: joins,
			parentLinked: linked.n > 0,
			readable: true,
		}
	} catch (error) {
		return { artifact, bytes, tables: 0, join: [], readable: false, reason: (error as Error).message.slice(0, 120) }
	} finally {
		db.destroy()
	}
}

/**
 * Every gazetteer-shaped artifact under the data root's `wof/` directory, plus the admin gazetteer beside it.
 *
 * `.prev`, `.bak` and journal siblings are excluded: they are on disk on purpose and censusing them reports the same
 * country twice under names nobody can act on.
 */
export async function gazetteerArtifacts(dataRoot?: string): Promise<string[]> {
	const wof = join(dataRoot ?? String(mailwomanDataRoot()), "wof")

	if (!(await pathExists(wof))) return []

	return (await readDirectory(wof))
		.filter((name) => name.endsWith(".db"))
		.filter((name) => !/\.(?:prev\d*|bak)\b/.test(name))
		.toSorted()
		.map((name) => join(wof, name))
}
