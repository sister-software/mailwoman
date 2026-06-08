/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a "slim" Who's On First SQLite distribution that's small enough to ship as a static asset
 *   for the browser-side mailwoman demo (Path B of the demo plan). The full admin distribution is
 *   ~2 GB; the slim variant aims for the ~50–100 MB range by keeping only the places a public demo
 *   will actually query for.
 *
 *   Selection policy (v1, US-focused):
 *
 *   - All countries / regions / counties / boroughs in the configured `countries` set, so the ancestor
 *       chain a locality / postcode reports through `parent_id` stays intact.
 *   - Top-K localities by population (read from the source's pre-built `place_population` aux table) in
 *       those countries.
 *   - All postcodes in those countries — they're small and addressing-relevant.
 *   - All `names` + `place_population` rows for selected place IDs.
 *   - The `coincident_roles` dual-role relation (#402), filtered to surviving spr ids.
 *
 *   No geojson, by design. The upstream WOF GeoJSON bodies live ONLY in the raw `whosonfirst-data-*`
 *   repos; `scripts/build-unified-wof.ts` extracts `wof:population` straight into
 *   `place_population` (and the bbox into `spr`) at ingest and never persists a `geojson` table. So
 *   the source admin DB carries population in `place_population`, and this builder consumes it
 *   directly — there is nothing to extract from, and nothing to drop.
 *
 *   The output DB has the resolver-facing schema: `spr`, `names`, `place_population`, plus the
 *   `place_search` FTS5 / `place_bbox` R*Tree virtual tables rebuilt against the trimmed row set
 *   (both derive purely from `spr` + `names` — see `fts.ts`). That means `WofSqlitePlaceLookup`
 *   opens the slim DB without any code change — it sees a smaller universe, nothing more.
 *
 *   Multi-shard inputs (e.g. admin + postcode) are processed in sequence; selected rows accumulate
 *   into the single output DB. The postcode shard contributes only postcodes; admin contributes
 *   everything else. Empty / missing input paths are skipped (callers pass `""` when a shard, such
 *   as a custom postcode DB, isn't built yet).
 */

import { SqliteDialect } from "@mailwoman/core/kysley/dialect"
import { Kysely, sql } from "kysely"
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { buildPlaceSearchFts, PLACE_BBOX_TABLE, PLACE_POPULATION_TABLE, PLACE_SEARCH_TABLE } from "./fts.js"
import type { NamesTable, SprTable } from "./schema.js"

export interface BuildSlimOptions {
	/** Input WOF SQLite distributions. Each should already have spr / names / place_population tables. */
	inputs: string[]
	/** Output path for the slim DB. Will be overwritten if it exists. */
	output: string
	/** Country codes to keep (ISO 2-letter). Defaults to `["US"]`. */
	countries?: string[]
	/** Cap on the number of localities to keep per country, by descending population. */
	topLocalitiesPerCountry?: number
	/**
	 * Drop the `names` table after the FTS index is built (default false). `place_search` is a
	 * self-contained FTS5 (no external `content=`), so once it's built `names` is only the build-time
	 * source — the resolver queries `place_search` + `spr` + `place_population` + `coincident_roles`
	 * and never reads `names` at runtime. Dropping it is the single biggest size win (~2/3 of the
	 * file for a multi-locale build; see #359). A future consumer that needs raw alt-names at runtime
	 * should ship a SEPARATE shard rather than re-bloat the hot DB.
	 */
	dropNames?: boolean
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
	| "place_population"
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
		placeSearch: number
		placeBbox: number
		placePopulation: number
	}
}

/** Placetypes that we always keep so the ancestor chain a selected locality reports stays valid. */
const ANCESTOR_PLACETYPES = ["country", "region", "county", "borough", "macroregion"] as const

/** Tables copied verbatim (schema + filtered rows) from each source DB. Anything else is dropped. */
const COPIED_TABLES = ["spr", "names", PLACE_POPULATION_TABLE] as const

/** Fallback DDL for `place_population` when the first source predates the aux table (defensive). */
const PLACE_POPULATION_DDL = `CREATE TABLE ${PLACE_POPULATION_TABLE} (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0)`

/** Minimal row shape for the population aux table — id + population, nothing else. */
interface PlacePopulationTable {
	id: number
	population: number
}

/**
 * Kysely schema for the build phase. Mirrors the resolver-facing tables, plus the ATTACHed `src.*`
 * tables so the row-copying queries can name the source schema in `selectFrom` without falling back
 * to raw SQL. ATTACH itself is still raw — Kysely doesn't model it — but everything downstream (the
 * SELECT-INSERT step that does the actual filtering work) goes through the builder.
 */
interface BuildSchema {
	spr: SprTable
	names: NamesTable
	place_population: PlacePopulationTable
	"src.spr": SprTable
	"src.names": NamesTable
	"src.place_population": PlacePopulationTable
}

export async function buildSlimWofDatabase(opts: BuildSlimOptions): Promise<BuildSlimResult> {
	const countries = (opts.countries ?? ["US"]).map((c) => c.toUpperCase())
	const topLocalities = opts.topLocalitiesPerCountry ?? 1000
	const progress = opts.onProgress ?? (() => {})

	// Callers pass `""` for shards that don't exist yet (e.g. a not-yet-built custom postcode DB).
	// Skip empties up front; require every remaining path to exist.
	const inputs = opts.inputs.filter((p) => p.length > 0)
	if (inputs.length === 0) throw new Error("no input WOF dbs provided")
	for (const input of inputs) {
		if (!existsSync(input)) throw new Error(`input WOF db not found: ${input}`)
	}

	progress("init", `${inputs.length} input(s) → ${opts.output}`)
	if (existsSync(opts.output)) rmSync(opts.output)

	// Open the output DB and create the empty schema. We discover the schema from the FIRST input
	// (raw sqlite_master read — Kysely doesn't model that) so the output mirrors source column
	// ordering / types. `CREATE TABLE AS SELECT` flattens types to dynamic, which would break
	// callers that rely on column-affinity behavior.
	const out = new DatabaseSync(opts.output)
	try {
		const firstSource = new DatabaseSync(inputs[0]!, { readOnly: true })
		try {
			progress("schema", "copying spr / names / place_population schemas from first input")
			for (const table of COPIED_TABLES) {
				const createSql = firstSource
					.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
					.get(table) as { sql?: string } | undefined
				if (createSql?.sql) {
					out.exec(createSql.sql)
				} else if (table === PLACE_POPULATION_TABLE) {
					// Older source builds may predate the aux table — create it empty so the per-source
					// copy + ranking have somewhere to land. Sparse-by-design; missing rows are fine.
					out.exec(PLACE_POPULATION_DDL)
				} else {
					throw new Error(`source DB ${inputs[0]} is missing required table '${table}'`)
				}
			}
			// PRIMARY KEY on spr.id + place_population.id come from the schemas we copied; an explicit
			// index on names.id helps the per-id INSERT SELECT later.
			out.exec(`CREATE INDEX IF NOT EXISTS names_id_idx ON names(id);`)
		} finally {
			firstSource.close()
		}

		const kysely = new Kysely<BuildSchema>({ dialect: new SqliteDialect({ database: out }) })

		// Pull rows from each input.
		for (const inputPath of inputs) {
			await copyFromSource(out, kysely, inputPath, countries, topLocalities, progress)
		}

		// Build the resolver virtual tables on the trimmed row set. Both place_search (FTS5) and
		// place_bbox (R*Tree) derive purely from spr + names — no geojson needed (see fts.ts). The
		// population aux table is NOT rebuilt here: it was copied verbatim above, and fts.ts only
		// (re)builds it when a `geojson` table is present, which the slim DB intentionally has not.
		progress("fts", "building place_search / place_bbox on slim DB")
		buildPlaceSearchFts(out, {
			drop: true, // schema we copied had no FTS tables, but be explicit
			onProgress: (phase, name) => progress("fts", `${phase} ${name}`),
		})

		// Capture the names count BEFORE any drop so the build report stays informative.
		const namesRows = countRows(out, "names")

		// Optionally drop `names` (+ its index) now that the self-contained FTS5 index no longer needs
		// it. The resolver never reads `names` at query time, so this is pure size reduction.
		if (opts.dropNames) {
			progress("vacuum", `dropping names table (${namesRows} rows; FTS5 is self-contained)`)
			out.exec(`DROP INDEX IF EXISTS names_id_idx;`)
			out.exec(`DROP TABLE IF EXISTS names;`)
		}

		// VACUUM the output so the on-disk file reflects just the trimmed row count. Without it the
		// file size stays inflated from the in-flight INSERT churn.
		progress("vacuum", "VACUUM (final size reduction)")
		out.exec("VACUUM;")

		const rowCounts = {
			spr: countRows(out, "spr"),
			names: namesRows,
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
			// Does this shard carry the pre-built population aux table? The admin source does; a bare
			// postcode shard might not. The locality ranking + population copy below adapt accordingly.
			const srcHasPopulation = Boolean(
				out.prepare(`SELECT 1 FROM src.sqlite_master WHERE type = 'table' AND name = '${PLACE_POPULATION_TABLE}'`).get()
			)

			// The SELECT-INSERT queries below go through Kysely. The cross-schema FROM is the only
			// "interesting" bit: by declaring `src.spr` / `src.names` / `src.place_population` in
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

			// 2. Top-K localities by population. Population lives in the pre-built `place_population`
			// aux table — left-join it so localities without a population row still qualify (sorted
			// last). If the shard has no population table, fall back to a deterministic id ordering.
			progress("locality", `${inputPath}: top-${topLocalities} localities by population`)
			await kysely
				.insertInto("spr")
				.expression((eb) =>
					eb
						.selectFrom("src.spr as s")
						.$if(srcHasPopulation, (qb) => qb.leftJoin("src.place_population as p", "p.id", "s.id"))
						.selectAll("s")
						.where("s.is_current", "!=", 0)
						.where("s.is_deprecated", "=", 0)
						.where("s.country", "in", countries)
						.where("s.placetype", "=", "locality")
						.orderBy(srcHasPopulation ? sql<number>`COALESCE(p.population, 0)` : sql<number>`s.id`, "desc")
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

			// 4. Pull names for the IDs we just selected.
			progress("names", `${inputPath}: names rows for selected IDs`)
			await kysely
				.insertInto("names")
				.expression((eb) => eb.selectFrom("src.names").selectAll().where("id", "in", eb.selectFrom("spr").select("id")))
				.onConflict((oc) => oc.doNothing())
				.execute()

			// 5. Pull population rows for the selected IDs (sparse — only the places WOF has a count for).
			if (srcHasPopulation) {
				progress("place_population", `${inputPath}: population rows for selected IDs`)
				await kysely
					.insertInto("place_population")
					.expression((eb) =>
						eb.selectFrom("src.place_population").selectAll().where("id", "in", eb.selectFrom("spr").select("id"))
					)
					.onConflict((oc) => oc.doNothing())
					.execute()
			}

			// 6. Carry the coincident_roles relation (#402) when this source has it (the admin DB), so the
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
