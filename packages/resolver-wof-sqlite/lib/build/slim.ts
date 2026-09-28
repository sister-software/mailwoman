/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { statPath, pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { copyFileTo, removePath } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { countRows } from "@mailwoman/sqlite"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { sql } from "kysely"
import type { Kysely } from "kysely"
import type { PathBuilderLike } from "path-ts"

import { buildPlaceSearchFTS, PLACE_BBOX_TABLE, PLACE_POPULATION_TABLE, PLACE_SEARCH_TABLE } from "#fts/index"
import type { NamesTable, SprTable, WOFDatabase } from "#schema"

export interface BuildSlimOptions {
	/**
	 * Input WOF SQLite distributions, each already carrying spr / names / place_population tables.
	 */
	inputs: readonly PathBuilderLike[]
	/**
	 * Output path for the slim DB, overwritten if it exists.
	 */
	output: PathBuilderLike
	/**
	 * Country codes to keep (ISO 2-letter); defaults to `["US"]`.
	 */
	countries?: string[]
	/**
	 * Cap on the number of localities to keep per country, by descending population.
	 */
	topLocalitiesPerCountry?: number
	/**
	 * Drop the `names` table after the FTS index is built; `place_search` is self-contained
	 * and the resolver never reads `names` at runtime.
	 */
	dropNames?: boolean

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
	| "place_abbr"
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

/**
 * Placetypes that we always keep so the ancestor chain a selected locality reports stays valid.
 */
const ANCESTOR_PLACETYPES = ["country", "region", "county", "borough", "macroregion"] as const

/**
 * Tables copied verbatim (schema + filtered rows) from each source DB.
 * Anything else is dropped.
 */
const COPIED_TABLES = ["spr", "names", PLACE_POPULATION_TABLE] as const

/**
 * Fallback DDL for `place_population` when the first source predates the aux table (defensive).
 */
const PLACE_POPULATION_DDL = `CREATE TABLE ${PLACE_POPULATION_TABLE} (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0)`

interface PlacePopulationTable {
	id: number
	population: number
}

/**
 * Kysely schema for the build phase, including the ATTACHed `src.*` tables
 * so row-copying queries can name the source schema.
 */
interface BuildSchema {
	spr: SprTable
	names: NamesTable
	place_population: PlacePopulationTable
	"src.spr": SprTable
	"src.names": NamesTable
	"src.place_population": PlacePopulationTable
}

export async function buildSlimWOFDatabase(opts: BuildSlimOptions): Promise<BuildSlimResult> {
	const countries = (opts.countries ?? ["US"]).map((c) => c.toUpperCase())
	const topLocalities = opts.topLocalitiesPerCountry ?? 1000
	const progress = opts.onProgress ?? (() => {})

	// An empty string marks an input that isn't built yet, so empties are skipped and every remaining path must exist.
	const inputs = opts.inputs.map((input) => input.toString()).filter((p) => p.length)

	if (!inputs.length) throw new Error("no input WOF dbs provided")

	for (const input of inputs) {
		if (!(await pathExists(input))) throw new Error(`input WOF db not found: ${input}`)
	}

	progress("init", `${inputs.length} input(s) → ${opts.output}`)

	if (await pathExists(opts.output)) {
		await removePath(opts.output)
	}

	// The output schema is replayed from the first input's sqlite_master so column ordering
	// and affinity survive; `create table AS select` would flatten types to dynamic.
	const out = new DatabaseClient<BuildSchema>(opts.output)
	let result: BuildSlimResult

	try {
		using firstSource = new DatabaseClient<WOFDatabase>(inputs[0]!, { readOnly: true })

		progress("schema", "copying spr / names / place_population schemas from first input")

		for (const table of COPIED_TABLES) {
			const createSQL = firstSource
				.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
				.get(table) as { sql?: string } | undefined

			if (createSQL?.sql) {
				// Raw DDL by design: the source DB's own create-table string cannot be expressed by a static Kysely builder.
				out.exec(createSQL.sql)
			} else if (table === PLACE_POPULATION_TABLE) {
				// Older source builds may predate the aux table, so create it empty for the copy and ranking.
				out.exec(PLACE_POPULATION_DDL)
			} else {
				throw new Error(`source DB ${inputs[0]} is missing required table '${table}'`)
			}
		}

		// The copied schemas define the primary keys.
		// This index on `names.id` helps the per-id insert select.
		out.exec(`CREATE INDEX IF NOT EXISTS names_id_idx ON names(id);`)

		// Pull rows from each input.
		for (const inputPath of inputs) {
			await copyFromSource(out, out, inputPath, countries, topLocalities, progress)
		}

		// `place_search` and `place_bbox` derive purely from `spr` + `names`, and the
		// population aux table is not rebuilt because it was copied verbatim.
		progress("fts", "building place_search / place_bbox on slim DB")

		buildPlaceSearchFTS(out, {
			drop: true, // schema we copied had no FTS tables, but be explicit
			onProgress: (phase, name) => progress("fts", `${phase} ${name}`),
		})

		// `place_abbr` is materialized before `names` is dropped and always created,
		// even empty, so the resolver can query it unconditionally.
		progress("place_abbr", "materializing region abbreviations")
		out.exec(`CREATE TABLE IF NOT EXISTS place_abbr (id INTEGER NOT NULL, abbr TEXT NOT NULL)`)
		out.exec(`INSERT INTO place_abbr (id, abbr) SELECT id, name FROM names WHERE language = 'abbr'`)
		out.exec(`CREATE INDEX IF NOT EXISTS place_abbr_by_abbr ON place_abbr (abbr COLLATE NOCASE)`)
		out.exec(`CREATE INDEX IF NOT EXISTS place_abbr_by_id ON place_abbr (id)`)

		const namesRows = countRows(out, "names")

		// The resolver never reads `names` at query time, so dropping it and its index is pure size reduction.
		if (opts.dropNames) {
			progress("vacuum", `dropping names table (${namesRows} rows; FTS5 is self-contained)`)
			out.exec(`DROP INDEX IF EXISTS names_id_idx;`)
			out.exec(`DROP TABLE IF EXISTS names;`)
		}

		// Vacuum so the on-disk file reflects the trimmed rows rather than the in-flight insert churn.
		progress("vacuum", "VACUUM (final size reduction)")
		out.exec("VACUUM;")

		const rowCounts = {
			spr: countRows(out, "spr"),
			names: namesRows,
			placeSearch: countRows(out, PLACE_SEARCH_TABLE),
			placeBbox: countRows(out, PLACE_BBOX_TABLE),
			placePopulation: countRows(out, PLACE_POPULATION_TABLE),
		}

		progress("done", stringifyJSON(rowCounts))

		result = {
			outputPath: opts.output.toString(),
			outputBytes: (await statPath(opts.output)).size,
			rowCounts,
		}
	} finally {
		await out.destroy()
	}

	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	await sealDatabase(opts.output)

	return result
}

async function copyFromSource(
	out: DatabaseClient<BuildSchema>,
	kysely: Kysely<BuildSchema>,
	inputPath: string,
	countries: string[],
	topLocalities: number,
	progress: NonNullable<BuildSlimOptions["onProgress"]>
): Promise<void> {
	// A fresh scratch copy is attached so read-only WOF distributions get the writable
	// journal they need without mutating the canonical files.
	await using tmpScratch = await temporaryDirectory("mailwoman-slim-src-")
	const scratchPath = tmpScratch.path("src.db")

	await copyFileTo(inputPath, scratchPath)

	out.exec(`ATTACH DATABASE '${scratchPath.toString().replaceAll("'", "''")}' AS src;`)

	try {
		const srcHasPopulation = Boolean(
			out.prepare(`SELECT 1 FROM src.sqlite_master WHERE type = 'table' AND name = '${PLACE_POPULATION_TABLE}'`).get()
		)

		// The `src.spr` declaration and its peers in `BuildSchema` let Kysely
		// column-check the cross-schema select.
		// SQLite reads the dotted identifier as a schema qualifier.

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

		// Localities without a population row still qualify.
		// Without the aux table, fall back to a deterministic id ordering.
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

		progress("names", `${inputPath}: names rows for selected IDs`)

		await kysely
			.insertInto("names")
			.expression((eb) => eb.selectFrom("src.names").selectAll().where("id", "in", eb.selectFrom("spr").select("id")))
			.onConflict((oc) => oc.doNothing())
			.execute()

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

		// `ancestors` is intentionally not copied, so the derived `coincident_roles`
		// table is copied and filtered to surviving spr ids.
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
}
