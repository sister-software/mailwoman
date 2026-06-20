/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a unified WOF SQLite database from cloned GeoJSON repos. Implements the WAL + Freeze design
 *   brief (docs/articles/reviews/2026-05-28-sqlite-wal-strategy.md).
 *
 *   Phase 1: Enumerate GeoJSON files across one or more repo directories. Phase 2: Ingest — parallel
 *   file reads (asyncParallelIterator), single-thread writer, WAL mode. Phase 2b (optional):
 *   backfill the Overture `divisions` theme for locales the WOF repos don't cover
 *   (`--overture-countries`). Phase 3: Freeze — checkpoint, journal_mode DELETE, indexes, ANALYZE,
 *   VACUUM INTO.
 *
 *   Usage: node scripts/build-unified-wof.js\
 *   --data /mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data\
 *   --output /mnt/playpen/mailwoman-data/wof/admin-global.db\
 *   [--concurrency 64] [--batch 500] [--overture-countries PT,PL,CZ,NO,FI,HR]
 *
 *   Accepts a parent directory containing multiple whosonfirst-data-admin-* subdirectories, or a
 *   single repo directory. `--overture-countries` folds the zero-DB-locale coverage (proven in the
 *   2026-06-20 sprint, project-eu-coverage-not-retrain) into the canonical build so the shipped
 *   admin DB carries global admin coverage in one file — superseding the standalone
 *   scripts/build-overture-divisions-gazetteer.py prototype. The Overture FTS rides the same
 *   `build-fts` step as the WOF rows.
 */

import { DuckDBInstance } from "@duckdb/node-api"
import { buildCoincidentRoles } from "@mailwoman/resolver-wof-sqlite/coincident-roles"
import {
	createUnifiedIndexes,
	createUnifiedSchema,
	populateAncestors,
} from "@mailwoman/resolver-wof-sqlite/unified-schema"
import FastGlob from "fast-glob"
import { existsSync, statSync, unlinkSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { asyncParallelIterator } from "spliterator"

/**
 * Synthetic id base for Overture-sourced rows — above any real WOF id (WOF ids are <~2e9), so a
 * combined DB never collides across sources. Matches scripts/build-overture-divisions-gazetteer.py
 * (the standalone falsification prototype this folds into the unified build).
 */
const OVERTURE_ID_BASE = 8_000_000_000_000
/** Overture division subtypes that map to the resolver's admin placetypes. */
const OVERTURE_DIVISION_SUBTYPES = ["locality", "region", "county", "localadmin"]
/** Pinned Overture release for the divisions theme (the release the EU coverage was validated on). */
const DEFAULT_OVERTURE_RELEASE = "2026-06-17.0"

interface Args {
	dataDir: string
	outputPath: string
	concurrency: number
	batchCommitSize: number
	/**
	 * Override the ingested placetype set (comma-separated). Defaults to ADMIN_PLACETYPES; pass
	 * `--placetypes postalcode` to build the postcode shard from whosonfirst-data-postalcode-*
	 * repos.
	 */
	placetypes?: string[]
	/**
	 * Comma-separated ISO 3166-1 alpha-2 codes to backfill from the Overture `divisions` theme AFTER
	 * the WOF GeoJSON ingest — the zero-DB locales the WOF repos don't cover (PT/PL/CZ/NO/FI/HR/…).
	 * Rows land in the SAME spr/names/place_population tables with synthetic ids, so the Freeze phase
	 * indexes them uniformly. Off unless provided. See project-eu-coverage-not-retrain.
	 */
	overtureCountries?: string[]
	/** Overture release for `--overture-countries` (the divisions theme is pinned per release). */
	overtureRelease: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	let dataDir: string | undefined
	let outputPath: string | undefined
	let concurrency = 64
	let batchCommitSize = 500
	let placetypes: string[] | undefined
	let overtureCountries: string[] | undefined
	let overtureRelease = DEFAULT_OVERTURE_RELEASE

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--data" && args[i + 1]) dataDir = args[++i]
		else if (args[i] === "--output" && args[i + 1]) outputPath = args[++i]
		else if (args[i] === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i]!, 10)
		else if (args[i] === "--batch" && args[i + 1]) batchCommitSize = parseInt(args[++i]!, 10)
		else if (args[i] === "--placetypes" && args[i + 1])
			placetypes = args[++i]!.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		else if (args[i] === "--overture-countries" && args[i + 1])
			overtureCountries = args[++i]!.split(",")
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean)
		else if (args[i] === "--overture-release" && args[i + 1]) overtureRelease = args[++i]!
	}

	if (!dataDir || !outputPath) {
		console.error(
			"Usage: node scripts/build-unified-wof.js --data <wof-repos-dir> --output <output.db> [--concurrency 64] [--batch 500] [--placetypes postalcode] [--overture-countries PT,PL,CZ] [--overture-release 2026-06-17.0]"
		)
		process.exit(1)
	}

	return { dataDir, outputPath, concurrency, batchCommitSize, placetypes, overtureCountries, overtureRelease }
}

const ADMIN_PLACETYPES = new Set([
	"country",
	"region",
	"county",
	"locality",
	"localadmin",
	"borough",
	"neighbourhood",
	"macroregion",
	"macrocounty",
])

interface ParsedFeature {
	id: number
	parent_id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	minLatitude: number
	minLongitude: number
	maxLatitude: number
	maxLongitude: number
	population: number
	isCurrent: number
	isDeprecated: number
	isCeased: number
	isSuperseded: number
	isSuperseding: number
	lastmodified: number
	concordances: Record<string, string | number>
	names: Array<{ name: string; language: string }>
}

function parseFeature(text: string, placetypes: Set<string>): ParsedFeature | null {
	const feature = JSON.parse(text)
	const props = feature.properties
	if (!props) return null

	const supersededBy = props["wof:superseded_by"]
	if (supersededBy && supersededBy.length > 0) return null

	const placetype = props["wof:placetype"]
	if (!placetypes.has(placetype)) return null

	const mzIsCurrent = props["mz:is_current"]

	const lat = typeof props["geom:latitude"] === "number" ? props["geom:latitude"] : 0
	const lon = typeof props["geom:longitude"] === "number" ? props["geom:longitude"] : 0
	// WOF `geom:bbox` is "minLon,minLat,maxLon,maxLat". Fall back to the centroid (a point bbox) when
	// absent — still correct for point-in-box proximity, the resolver's main bbox use.
	let [minLon, minLat, maxLon, maxLat] = [lon, lat, lon, lat]
	const bboxStr = props["geom:bbox"]
	if (typeof bboxStr === "string") {
		const parts = bboxStr.split(",").map(Number)
		if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
			;[minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number]
		}
	}

	const names: Array<{ name: string; language: string }> = []
	for (const [key, value] of Object.entries(props)) {
		const match = key.match(/^name:([a-z]{3})_x_(preferred|variant)$/)
		if (!match || !value) continue
		const lang = match[1]!
		const vals = Array.isArray(value) ? value : [value]
		for (const v of vals) {
			if (typeof v === "string" && v.length > 0) {
				names.push({ name: v, language: lang })
			}
		}
	}

	return {
		id: props["wof:id"],
		parent_id: props["wof:parent_id"] ?? -1,
		name: props["wof:name"] ?? "",
		placetype,
		country: props["wof:country"] ?? "",
		latitude: lat,
		longitude: lon,
		minLatitude: minLat,
		minLongitude: minLon,
		maxLatitude: maxLat,
		maxLongitude: maxLon,
		population: props["wof:population"] ?? props["gn:population"] ?? 0,
		isCurrent: mzIsCurrent === 0 || mzIsCurrent === "0" ? 0 : 1,
		isDeprecated: props["edtf:deprecated"] ? 1 : 0,
		isCeased: props["edtf:cessation"] ? 1 : 0,
		isSuperseded: (props["wof:superseded_by"]?.length ?? 0) > 0 ? 1 : 0,
		isSuperseding: (props["wof:supersedes"]?.length ?? 0) > 0 ? 1 : 0,
		lastmodified: typeof props["wof:lastmodified"] === "number" ? props["wof:lastmodified"] : 0,
		concordances: props["wof:concordances"] ?? {},
		names,
	}
}

/**
 * Backfill the Overture `divisions` theme into an already-open unified ingest DB, for locales the
 * WOF GeoJSON repos don't cover (the 2026-06-20 zero-DB EU set). Writes the SAME spr/names/
 * place_population tables the WOF path uses — with synthetic ids based at {@link OVERTURE_ID_BASE}
 * so the two sources never collide — so the caller's Freeze phase (ancestors closure,
 * coincident_roles, indexes, FTS) treats them uniformly. The Overture sub-tree is self-contained
 * (locality → region → county via `parent_division_id`); a division whose parent we didn't ingest
 * tops out at -1. Country scoping rides `spr.country` (set on every row), not the ancestry, so no
 * WOF country node is needed.
 *
 * The heavy native `@duckdb/node-api` dependency lives here in `scripts/` only — never in
 * `@mailwoman/corpus` (a runtime dep of the `mailwoman` CLI) — the same split as
 * `ingest-overture-addresses.ts`.
 *
 * @returns The number of divisions ingested.
 */
export async function ingestOvertureDivisions(
	db: DatabaseSync,
	countries: string[],
	release: string,
	/**
	 * Starting synthetic id. Defaults to {@link OVERTURE_ID_BASE} (a single full build). An
	 * INCREMENTAL augment of a DB that ALREADY holds Overture rows MUST pass `max(spr.id) + 1` so the
	 * new ids don't collide with — and `INSERT OR REPLACE` clobber — the existing ones.
	 */
	idBase: number = OVERTURE_ID_BASE
): Promise<number> {
	const inlist = countries.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")
	const subtypes = OVERTURE_DIVISION_SUBTYPES.map((s) => `'${s}'`).join(",")
	const glob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division/*`

	const instance = await DuckDBInstance.create()
	const con = await instance.connect()
	await con.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
	await con.run("SET memory_limit='4GB'; SET threads=4;")

	console.error(`  Overture divisions: querying ${countries.join(",")} @ release ${release}...`)
	const result = await con.runAndReadAll(`
		SELECT id,
			names.primary AS name,
			subtype,
			country,
			ST_Y(ST_Centroid(geometry)) AS lat,
			ST_X(ST_Centroid(geometry)) AS lon,
			bbox.ymin AS min_lat, bbox.ymax AS max_lat, bbox.xmin AS min_lon, bbox.xmax AS max_lon,
			parent_division_id,
			population
		FROM read_parquet('${glob}')
		WHERE country IN (${inlist}) AND subtype IN (${subtypes})
			AND names.primary IS NOT NULL AND geometry IS NOT NULL
	`)
	const rows = result.getRowObjects() as Array<Record<string, unknown>>
	console.error(`  Overture divisions: ${rows.length.toLocaleString()} pulled`)

	// GERS string id → synthetic int, sequential and unique within this run.
	const idmap = new Map<string, number>()
	rows.forEach((r, i) => idmap.set(String(r.id), idBase + i))

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, ?, ?, ?, ?)`
	)
	const populationInsert = db.prepare(`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`)

	const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0)

	db.exec("BEGIN")
	let n = 0
	for (const r of rows) {
		const nid = idmap.get(String(r.id))!
		const pgers = r.parent_division_id == null ? null : String(r.parent_division_id)
		const pid = (pgers && idmap.get(pgers)) || -1
		const name = String(r.name)
		const subtype = String(r.subtype)
		const country = String(r.country ?? "").toUpperCase()
		// SELECT aliases: min_lat=ymin, min_lon=xmin, max_lat=ymax, max_lon=xmax → spr (lat, lon,
		// min_latitude, min_longitude, max_latitude, max_longitude).
		sprInsert.run(
			nid,
			pid,
			name,
			subtype,
			country,
			num(r.lat),
			num(r.lon),
			num(r.min_lat),
			num(r.min_lon),
			num(r.max_lat),
			num(r.max_lon),
			1,
			0,
			0,
			0,
			0,
			0
		)
		namesInsert.run(nid, name, subtype, country, "", 0)
		const pop = num(r.population)
		if (pop > 0) populationInsert.run(nid, pop)
		n++
	}
	db.exec("COMMIT")
	return n
}

async function main() {
	const { dataDir, outputPath, concurrency, batchCommitSize, placetypes, overtureCountries, overtureRelease } =
		parseArgs()
	const activePlacetypes = placetypes ? new Set(placetypes) : ADMIN_PLACETYPES
	console.error(`Ingesting placetypes: ${[...activePlacetypes].join(", ")}`)
	const t0 = performance.now()
	const ingestPath = outputPath + ".ingest"

	if (existsSync(ingestPath)) unlinkSync(ingestPath)

	// -----------------------------------------------------------------------
	// Phase 1: Enumerate
	// -----------------------------------------------------------------------
	console.error(`Scanning ${dataDir} for GeoJSON files...`)
	const filePaths = await FastGlob("**/data/**/*.geojson", {
		cwd: dataDir,
		absolute: true,
		ignore: ["**/*-alt-*"],
	})
	console.error(`  Found ${filePaths.length.toLocaleString()} files (excluding -alt- variants)`)

	// -----------------------------------------------------------------------
	// Phase 2: Ingest (WAL mode, single-thread writer, parallel file reads)
	// -----------------------------------------------------------------------
	console.error(`Creating ingest DB at ${ingestPath}...`)
	const db = new DatabaseSync(ingestPath)
	db.exec(`
		PRAGMA page_size = 8192;
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 30000;
		PRAGMA temp_store = MEMORY;
		PRAGMA cache_size = -200000;
	`)
	createUnifiedSchema(db)

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, ?, ?, ?, ?)`
	)
	const concordancesInsert = db.prepare(
		`INSERT INTO concordances (id, other_id, other_source, lastmodified) VALUES (?, ?, ?, ?)`
	)
	const populationInsert = db.prepare(`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`)

	let processed = 0
	let skipped = 0
	let inTransaction = false

	function beginIfNeeded() {
		if (!inTransaction) {
			db.exec("BEGIN TRANSACTION")
			inTransaction = true
		}
	}

	function commitIfNeeded(force = false) {
		if (inTransaction && (force || processed % batchCommitSize === 0)) {
			db.exec("COMMIT")
			inTransaction = false
		}
	}

	console.error(`Ingesting with concurrency=${concurrency}, batch commit every ${batchCommitSize} files...`)

	const readResults = asyncParallelIterator(filePaths, concurrency, (filePath) => readFile(filePath, "utf8"))

	for await (const text of readResults) {
		const feature = parseFeature(text, activePlacetypes)
		if (!feature) {
			skipped++
			continue
		}

		beginIfNeeded()

		sprInsert.run(
			feature.id,
			feature.parent_id,
			feature.name,
			feature.placetype,
			feature.country,
			feature.latitude,
			feature.longitude,
			feature.minLatitude,
			feature.minLongitude,
			feature.maxLatitude,
			feature.maxLongitude,
			feature.isCurrent,
			feature.isDeprecated,
			feature.isCeased,
			feature.isSuperseded,
			feature.isSuperseding,
			feature.lastmodified
		)

		for (const n of feature.names) {
			namesInsert.run(feature.id, n.name, feature.placetype, feature.country, n.language, feature.lastmodified)
		}

		for (const [source, value] of Object.entries(feature.concordances)) {
			concordancesInsert.run(feature.id, String(value), source, feature.lastmodified)
		}

		if (feature.population > 0) {
			populationInsert.run(feature.id, feature.population)
		}

		processed++
		commitIfNeeded()

		if (processed % 25000 === 0) {
			const elapsed = (performance.now() - t0) / 1000
			const rate = processed / elapsed
			const eta = (filePaths.length - processed - skipped) / rate
			console.error(
				`  ${processed.toLocaleString()} processed, ${skipped.toLocaleString()} skipped (${rate.toFixed(0)}/s, ETA ${eta.toFixed(0)}s)`
			)
		}
	}

	commitIfNeeded(true)
	const ingestElapsed = ((performance.now() - t0) / 1000).toFixed(1)
	console.error(
		`Ingest complete in ${ingestElapsed}s: ${processed.toLocaleString()} places, ${skipped.toLocaleString()} skipped`
	)

	// -----------------------------------------------------------------------
	// Phase 2b: Overture divisions backfill (zero-DB locales the WOF repos miss)
	// -----------------------------------------------------------------------
	let overtureIngested = 0
	if (overtureCountries && overtureCountries.length > 0) {
		console.error(`Backfilling Overture divisions for ${overtureCountries.join(",")}...`)
		overtureIngested = await ingestOvertureDivisions(db, overtureCountries, overtureRelease)
		console.error(`  Overture divisions ingested: ${overtureIngested.toLocaleString()}`)
	}

	// -----------------------------------------------------------------------
	// Phase 3: Freeze
	// -----------------------------------------------------------------------
	console.error("Freezing...")

	const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
		busy: number
		log: number
		checkpointed: number
	}
	if (checkpoint.busy !== 0) {
		throw new Error(`WAL checkpoint did not finish: ${JSON.stringify(checkpoint)}`)
	}
	console.error("  WAL checkpoint complete")

	const mode = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }
	if (mode.journal_mode !== "delete") {
		throw new Error(`journal_mode switch failed; still ${mode.journal_mode}`)
	}
	console.error("  journal_mode = delete")

	console.error("  Building ancestors (parent_id closure)...")
	const ancestorRows = populateAncestors(db)
	console.error(`  ancestors: ${ancestorRows} rows`)

	// Dual-role-place relation (#403, epic #402) — needs `ancestors` + `spr` bbox + `place_population`,
	// all present by now. Drives the resolver's hierarchy completion (on by default). Tiny (~hundreds of
	// rows); `build-slim` carries it through to the shipped DB.
	console.error("  Building coincident_roles (dual-role places)...")
	const roles = buildCoincidentRoles(db)
	console.error(`  coincident_roles: ${roles.rowCount} rows`)

	console.error("  Creating indexes...")
	createUnifiedIndexes(db)

	console.error("  ANALYZE...")
	db.exec("ANALYZE")
	db.exec("PRAGMA optimize")

	const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
	if (integrity.integrity_check !== "ok") {
		throw new Error(`integrity_check failed: ${integrity.integrity_check}`)
	}
	console.error("  integrity_check = ok")

	if (existsSync(outputPath)) {
		const s = statSync(outputPath)
		if (s.size > 0) unlinkSync(outputPath)
	}
	db.prepare("VACUUM INTO ?").run(outputPath)
	console.error(`  VACUUM INTO ${outputPath}`)

	db.close()
	unlinkSync(ingestPath)
	for (const sidecar of [ingestPath + "-wal", ingestPath + "-shm"]) {
		if (existsSync(sidecar)) unlinkSync(sidecar)
	}

	// Verify frozen artifact
	const frozen = new DatabaseSync(outputPath, { readOnly: true })
	const frozenMode = frozen.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
	frozen.close()
	if (frozenMode.journal_mode !== "delete") {
		throw new Error(`frozen DB journal_mode=${frozenMode.journal_mode}`)
	}

	const finalSize = (statSync(outputPath).size / 1024 / 1024).toFixed(1)
	const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1)
	console.error(`\nDone in ${totalElapsed}s:`)
	console.error(`  Places:  ${processed.toLocaleString()}`)
	if (overtureIngested > 0) console.error(`  Overture: ${overtureIngested.toLocaleString()}`)
	console.error(`  Skipped: ${skipped.toLocaleString()}`)
	console.error(`  Output:  ${outputPath} (${finalSize} MB)`)
}

// Only run the full build when executed directly — importing this module (e.g. to reuse
// `ingestOvertureDivisions` for an incremental single-country augment) must not trigger a build.
if (import.meta.main) {
	main().catch((err) => {
		console.error(err)
		process.exit(1)
	})
}
