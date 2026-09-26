/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * What data the repository holds, per country and per artifact — the question before `lookup-sources.ts`'s "does this
 * source know this string".
 *
 * A row count is a misleading yes, so `join` and `parentLinked` are reported: `postalcode-geonames-intl.db` holds
 * 395,544 PT postcodes and is `spr`-only, and even `postalcode-intl.db`'s `ancestors` table reaches no locality when
 * every `parent_id` is `-1`. A zero-byte or table-less extract is reported unreadable rather than as zero rows.
 *
 * Absence is reported, never omitted: "the query returned no rows" and "we never looked there" are different facts.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * What an extract can be joined through, which decides what a corpus builder can extract from it;
 * `ancestry` promises only that the table exists, not that the chain reaches a locality.
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
	 * Present only when the artifact carries an `spr` table; a file without one is
	 * reported unreadable with a reason rather than a zero.
	 */
	countries?: Record<string, number>
	join: JoinCapability[]
	/**
	 * Whether any row carries a usable `parent_id`; an extract whose every row reads
	 * `-1` cannot be walked upward, which is invisible from a row count.
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
 * Census one SQLite artifact without throwing, because an unreadable file is a finding rather than an error.
 */
export async function censusArtifact(path: string, countries?: readonly string[]): Promise<SourceCensusRow> {
	const artifact = path.split("/").pop() ?? path

	if (!(await pathExists(path))) {
		return { artifact, bytes: 0, tables: 0, join: [], readable: false, reason: "not on disk" }
	}

	const bytes = (await statPath(path)).size

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

		// Asked for and absent is a reported zero, never a missing key, because the
		// caller is deciding whether to acquire data.
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
 * Every gazetteer-shaped artifact under the data root's `db/wof/` directory,
 * plus the admin gazetteer beside it; `.prev`, `.bak` and journal siblings are excluded
 * because censusing them reports the same country twice under names nobody can act on.
 */
export async function gazetteerArtifacts(source: PathBuilderLike = dataRootPath()): Promise<string[]> {
	const wof = wofDatabaseRoot(source)

	if (!(await pathExists(wof))) return []

	return (await Globerator.files("db", { cwd: wof, absolute: false, recursive: false }).toArray())
		.filter((name) => !/\.(?:prev\d*|bak)\b/.test(name))
		.toSorted()
		.map((name) => wof(name).toString())
}
