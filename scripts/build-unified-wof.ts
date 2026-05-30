/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a unified WOF SQLite database from cloned GeoJSON repos. Implements the WAL + Freeze design
 *   brief (docs/articles/reviews/2026-05-28-sqlite-wal-strategy.md).
 *
 *   Phase 1: Enumerate GeoJSON files across one or more repo directories. Phase 2: Ingest — parallel
 *   file reads (asyncParallelIterator), single-thread writer, WAL mode. Phase 3: Freeze —
 *   checkpoint, journal_mode DELETE, indexes, ANALYZE, VACUUM INTO.
 *
 *   Usage: node scripts/build-unified-wof.js\
 *   --data /mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data\
 *   --output /mnt/playpen/mailwoman-data/wof/admin-global.db\
 *   [--concurrency 64] [--batch 500]
 *
 *   Accepts a parent directory containing multiple whosonfirst-data-admin-* subdirectories, or a
 *   single repo directory.
 */

import { createUnifiedIndexes, createUnifiedSchema, populateAncestors } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import FastGlob from "fast-glob"
import { existsSync, statSync, unlinkSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { asyncParallelIterator } from "spliterator"

interface Args {
	dataDir: string
	outputPath: string
	concurrency: number
	batchCommitSize: number
	/** Override the ingested placetype set (comma-separated). Defaults to ADMIN_PLACETYPES; pass
	 *  `--placetypes postalcode` to build the postcode shard from whosonfirst-data-postalcode-* repos. */
	placetypes?: string[]
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	let dataDir: string | undefined
	let outputPath: string | undefined
	let concurrency = 64
	let batchCommitSize = 500
	let placetypes: string[] | undefined

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--data" && args[i + 1]) dataDir = args[++i]
		else if (args[i] === "--output" && args[i + 1]) outputPath = args[++i]
		else if (args[i] === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i]!, 10)
		else if (args[i] === "--batch" && args[i + 1]) batchCommitSize = parseInt(args[++i]!, 10)
		else if (args[i] === "--placetypes" && args[i + 1]) placetypes = args[++i]!.split(",").map((s) => s.trim()).filter(Boolean)
	}

	if (!dataDir || !outputPath) {
		console.error(
			"Usage: node scripts/build-unified-wof.js --data <wof-repos-dir> --output <output.db> [--concurrency 64] [--batch 500] [--placetypes postalcode]"
		)
		process.exit(1)
	}

	return { dataDir, outputPath, concurrency, batchCommitSize, placetypes }
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

async function main() {
	const { dataDir, outputPath, concurrency, batchCommitSize, placetypes } = parseArgs()
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
	console.error(`  Skipped: ${skipped.toLocaleString()}`)
	console.error(`  Output:  ${outputPath} (${finalSize} MB)`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
