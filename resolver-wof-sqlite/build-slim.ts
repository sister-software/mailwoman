/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a "slim" Who's On First SQLite distribution that's small enough to ship as a static asset
 *   for the browser-side mailwoman demo (Path B of the demo plan). The full admin-US distribution
 *   is ~4 GB; the slim variant aims for the ~50–100 MB range by keeping only the places a public
 *   demo will actually query for.
 *
 *   Selection policy (v1, US-focused):
 *
 *   - All countries / regions / counties / boroughs in the configured `countries` set, so the ancestor
 *       chain a locality / postcode reports through `parent_id` stays intact.
 *   - Top-K localities by `wof:population` (extracted via the `place_population` aux table the full WOF
 *       build already emits) in those countries.
 *   - All postcodes in those countries — they're small and addressing-relevant.
 *   - All `names` rows + `geojson` rows for selected place IDs.
 *
 *   The output DB has the same logical schema as the source: `spr`, `names`, `geojson`, plus the
 *   `place_search` FTS5 / `place_bbox` R*Tree / `place_population` aux tables built fresh against
 *   the trimmed row set. That means `WofSqlitePlaceLookup` opens the slim DB without any code
 *   change — it sees a smaller universe, nothing more.
 *
 *   Multi-shard inputs (e.g. admin-us + postcode-us) are processed in sequence; selected rows
 *   accumulate into the single output DB. The postcode shard contributes only postcodes; admin
 *   contributes everything else.
 */

import { SqliteDialect } from "@mailwoman/core/kysley/dialect"
import { Kysely, sql } from "kysely"
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { buildPlaceSearchFts, PLACE_BBOX_TABLE, PLACE_POPULATION_TABLE, PLACE_SEARCH_TABLE } from "./fts.js"
import type { GeojsonTable, NamesTable, SprTable } from "./schema.js"

export interface BuildSlimOptions {
	/** Input WOF SQLite distributions. Each should already have spr / names / geojson tables. */
	inputs: string[]
	/** Output path for the slim DB. Will be overwritten if it exists. */
	output: string
	/** Country codes to keep (ISO 2-letter). Defaults to `["US"]`. */
	countries?: string[]
	/** Cap on the number of localities to keep per country, by descending population. */
	topLocalitiesPerCountry?: number
	/** Optional progress callback for CLI / test introspection. */
	onProgress?: (phase: SlimBuildPhase, detail: string) => void
}

export type SlimBuildPhase =
	| "init"
	| "schema"
	| "country"
	| "region"
	| "county"
	| "locality"
	| "postcode"
	| "names"
	| "geojson"
	| "coincident_roles"
	| "fts"
	| "vacuum"
	| "done"

export interface BuildSlimResult {
	outputPath: string
	outputBytes: number
	rowCounts: {
		spr: number
		names: number
		geojson: number
		placeSearch: number
		placeBbox: number
		placePopulation: number
	}
}

/** Placetypes that we always keep so the ancestor chain a selected locality reports stays valid. */
const ANCESTOR_PLACETYPES = ["country", "region", "county", "borough", "macroregion"] as const

/** Names of the tables we copy from each source DB. Anything outside this list is dropped. */
const COPIED_TABLES = ["spr", "names", "geojson"] as const

/**
 * Kysely schema for the build phase. Mirrors {@link WofDatabase}, but adds the ATTACHed `src.*`
 * tables so the row-copying queries can name the source schema in `selectFrom` without falling back
 * to raw SQL. ATTACH itself is still raw — Kysely doesn't model it — but everything downstream (the
 * SELECT-INSERT step that does the actual filtering work) goes through the builder.
 */
interface BuildSchema {
	spr: SprTable
	names: NamesTable
	geojson: GeojsonTable
	"src.spr": SprTable
	"src.names": NamesTable
	"src.geojson": GeojsonTable
}

export async function buildSlimWofDatabase(opts: BuildSlimOptions): Promise<BuildSlimResult> {
	const countries = (opts.countries ?? ["US"]).map((c) => c.toUpperCase())
	const topLocalities = opts.topLocalitiesPerCountry ?? 1000
	const progress = opts.onProgress ?? (() => {})

	for (const input of opts.inputs) {
		if (!existsSync(input)) throw new Error(`input WOF db not found: ${input}`)
	}

	progress("init", `${opts.inputs.length} input(s) → ${opts.output}`)
	if (existsSync(opts.output)) rmSync(opts.output)

	// Open the output DB and create the empty schema. We discover the schema from the FIRST input
	// (raw sqlite_master read — Kysely doesn't model that) so the output mirrors source column
	// ordering / types. `CREATE TABLE AS SELECT` flattens types to dynamic, which would break
	// callers that rely on column-affinity behavior.
	const out = new DatabaseSync(opts.output)
	try {
		const firstSource = new DatabaseSync(opts.inputs[0]!, { readOnly: true })
		try {
			progress("schema", "copying spr / names / geojson schemas from first input")
			for (const table of COPIED_TABLES) {
				const createSql = firstSource
					.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
					.get(table) as { sql?: string } | undefined
				if (!createSql?.sql) {
					throw new Error(`source DB ${opts.inputs[0]} is missing required table '${table}'`)
				}
				out.exec(createSql.sql)
			}
			// PRIMARY KEY on spr.id is in the schema we copied; explicit indexes on names.id /
			// geojson.id help the per-id INSERT SELECT later.
			out.exec(`CREATE INDEX IF NOT EXISTS names_id_idx ON names(id);`)
			out.exec(`CREATE INDEX IF NOT EXISTS geojson_id_idx ON geojson(id);`)
		} finally {
			firstSource.close()
		}

		const kysely = new Kysely<BuildSchema>({ dialect: new SqliteDialect({ database: out }) })

		// Pull rows from each input.
		for (const inputPath of opts.inputs) {
			await copyFromSource(out, kysely, inputPath, countries, topLocalities, progress)
		}

		// Build the resolver virtual tables on the trimmed row set. We call buildPlaceSearchFts
		// after all data is in place so place_population's geojson scan sees the merged geojson
		// table, not a per-input partial.
		progress("fts", "building place_search / place_bbox / place_population on slim DB")
		buildPlaceSearchFts(out, {
			drop: true, // schema we copied had no FTS tables, but be explicit
			onProgress: (phase, name) => progress("fts", `${phase} ${name}`),
		})

		// geojson is only used during the BUILD phase (place_population extracts wof:population from
		// it; FTS docs key off names, not geojson). Lookup.ts never reads it at query time. For a
		// public demo bundle, geojson dominates the file size — admin-US polygons alone are >1 GB —
		// while contributing nothing to query behavior. Drop it after the aux tables are built; the
		// slim DB still resolves identically.
		progress("vacuum", "dropping geojson table (build-time only; ~95% of file size)")
		out.exec(`DROP INDEX IF EXISTS geojson_id_idx;`)
		out.exec(`DROP TABLE IF EXISTS geojson;`)

		// VACUUM the output so the on-disk file reflects just the trimmed row count. Without it the
		// file size stays inflated from the in-flight INSERT churn.
		progress("vacuum", "VACUUM (final size reduction)")
		out.exec("VACUUM;")

		const rowCounts = {
			spr: countRows(out, "spr"),
			names: countRows(out, "names"),
			geojson: 0, // dropped above; reported as 0 for stability
			placeSearch: countRows(out, PLACE_SEARCH_TABLE),
			placeBbox: countRows(out, PLACE_BBOX_TABLE),
			placePopulation: countRows(out, PLACE_POPULATION_TABLE),
		}
		progress("done", JSON.stringify(rowCounts))

		return {
			outputPath: opts.output,
			outputBytes: statSync(opts.output).size,
			rowCounts,
		}
	} finally {
		out.close()
	}
}

async function copyFromSource(
	out: DatabaseSync,
	kysely: Kysely<BuildSchema>,
	inputPath: string,
	countries: string[],
	topLocalities: number,
	progress: NonNullable<BuildSlimOptions["onProgress"]>
): Promise<void> {
	// ATTACH avoids any "load source into memory" step — SQLite walks both files in place. We need
	// a fresh temp copy because some WOF distributions ship as read-only filesystem mounts and
	// ATTACH will still want a writable journal on the side; copying to /tmp dodges that without
	// mutating the canonical files in /mnt/playpen/mailwoman-data/wof/. ATTACH / DETACH stay raw
	// — Kysely doesn't model them.
	const tmpScratch = mkdtempSync(join(tmpdir(), "mailwoman-slim-src-"))
	const scratchPath = join(tmpScratch, "src.db")
	copyFileSync(inputPath, scratchPath)
	try {
		out.exec(`ATTACH DATABASE '${scratchPath.replace(/'/g, "''")}' AS src;`)
		try {
			// All four SELECT-INSERT queries below go through Kysely. The cross-schema FROM is the
			// only "interesting" bit: by declaring `src.spr` / `src.names` / `src.geojson` in
			// `BuildSchema`, Kysely lets us write `selectFrom("src.spr")` with the same column-type
			// checking as the regular schema. SQLite parses the dotted identifier as a schema-name
			// qualifier, so this works directly without any aliasing trick.

			// 1. Ancestor placetypes (country / region / county / etc.) — always-kept.
			progress("country", `${inputPath}: ancestor placetypes in (${countries.join(",")})`)
			await kysely
				.insertInto("spr")
				.expression((eb) =>
					eb
						.selectFrom("src.spr")
						.selectAll()
						.where("is_current", "!=", 0)
						.where("is_deprecated", "=", 0)
						.where("country", "in", countries)
						.where("placetype", "in", [...ANCESTOR_PLACETYPES])
				)
				.onConflict((oc) => oc.doNothing())
				.execute()

			// 2. Top-K localities by population. wof:population lives in the geojson body, so we
			// rank via json_extract. SQLite's json_extract isn't in Kysely's `eb.fn` catalog;
			// `sql` template literal is the canonical escape hatch (same pattern lookup.ts uses
			// for FTS5 MATCH).
			progress("locality", `${inputPath}: top-${topLocalities} localities by population`)
			await kysely
				.insertInto("spr")
				.expression((eb) =>
					eb
						.selectFrom("src.spr as s")
						.leftJoin("src.geojson as g", "g.id", "s.id")
						.selectAll("s")
						.where("s.is_current", "!=", 0)
						.where("s.is_deprecated", "=", 0)
						.where("s.country", "in", countries)
						.where("s.placetype", "=", "locality")
						.orderBy(
							sql<number>`COALESCE(CAST(json_extract(g.body, '$.properties."wof:population"') AS INTEGER), 0)`,
							"desc"
						)
						.limit(topLocalities)
				)
				.onConflict((oc) => oc.doNothing())
				.execute()

			// 3. All postcodes in scope.
			progress("postcode", `${inputPath}: all postcodes`)
			await kysely
				.insertInto("spr")
				.expression((eb) =>
					eb
						.selectFrom("src.spr")
						.selectAll()
						.where("is_current", "!=", 0)
						.where("is_deprecated", "=", 0)
						.where("country", "in", countries)
						.where("placetype", "=", "postalcode")
				)
				.onConflict((oc) => oc.doNothing())
				.execute()

			// 4. Pull names / geojson for the IDs we just selected. Restrict to those IDs so we
			// don't drag the full 4 GB geojson over.
			progress("names", `${inputPath}: names rows for selected IDs`)
			await kysely
				.insertInto("names")
				.expression((eb) => eb.selectFrom("src.names").selectAll().where("id", "in", eb.selectFrom("spr").select("id")))
				.onConflict((oc) => oc.doNothing())
				.execute()

			progress("geojson", `${inputPath}: geojson rows for selected IDs`)
			await kysely
				.insertInto("geojson")
				.expression((eb) =>
					eb.selectFrom("src.geojson").selectAll().where("id", "in", eb.selectFrom("spr").select("id"))
				)
				.onConflict((oc) => oc.doNothing())
				.execute()

			// Carry the coincident_roles relation (#402) when this source has it (the admin DB), so the
			// slim/demo DB supports dual-role hierarchy completion (on by default). Filtered to surviving
			// spr ids → no orphans. Tiny (~hundreds of rows). `ancestors` is intentionally NOT copied (huge
			// + build-only), so we copy the derived table rather than rebuild it. Raw SQL — conditional +
			// not in the Kysely build schema.
			const relationSchema = out
				.prepare(`SELECT sql FROM src.sqlite_master WHERE type = 'table' AND name = 'coincident_roles'`)
				.get() as { sql?: string } | undefined
			if (relationSchema?.sql) {
				progress("coincident_roles", `${inputPath}: copying dual-role relation`)
				out.exec(relationSchema.sql.replace(/CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS"))
				out.exec(
					`INSERT OR IGNORE INTO coincident_roles SELECT * FROM src.coincident_roles
						WHERE admin_id IN (SELECT id FROM spr) AND locality_id IN (SELECT id FROM spr)`
				)
				out.exec(`CREATE INDEX IF NOT EXISTS coincident_roles_by_admin ON coincident_roles (admin_id)`)
			}
		} finally {
			out.exec(`DETACH DATABASE src;`)
		}
	} finally {
		rmSync(tmpScratch, { recursive: true, force: true })
	}
}

function countRows(db: DatabaseSync, table: string): number {
	const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined
	return Number(row?.n ?? 0)
}
