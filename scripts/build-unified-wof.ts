/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a unified WOF SQLite database from cloned GeoJSON repos. Produces the same schema
 *   as geocode.earth's pre-built distributions so the FST builder and resolver work unchanged.
 *
 *   Uses spliterator's asyncParallelIterator for bounded-concurrency file reads — the 293K
 *   GeoJSON files are 50/50 I/O and CPU bound, so pipelining async reads with synchronous
 *   parse+INSERT gives ~2x throughput over fully sequential.
 *
 *   Usage:
 *     UV_THREADPOOL_SIZE=8 npx tsx scripts/build-unified-wof.ts \
 *       --data /mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data-admin-us/data \
 *       --output /mnt/playpen/mailwoman-data/wof/wof-admin-us-unified.db
 */

import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { asyncParallelIterator } from "spliterator"
import FastGlob from "fast-glob"
import { createUnifiedSchema, createUnifiedIndexes } from "@mailwoman/resolver-wof-sqlite/unified-schema"

interface Args {
	dataDir: string
	outputPath: string
	concurrency: number
	batchCommitSize: number
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	let dataDir: string | undefined
	let outputPath: string | undefined
	let concurrency = 64
	let batchCommitSize = 500

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--data" && args[i + 1]) dataDir = args[++i]
		else if (args[i] === "--output" && args[i + 1]) outputPath = args[++i]
		else if (args[i] === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i]!, 10)
		else if (args[i] === "--batch" && args[i + 1]) batchCommitSize = parseInt(args[++i]!, 10)
	}

	if (!dataDir || !outputPath) {
		console.error("Usage: npx tsx scripts/build-unified-wof.ts --data <wof-data-dir> --output <output.db> [--concurrency 64] [--batch 500]")
		process.exit(1)
	}

	return { dataDir, outputPath, concurrency, batchCommitSize }
}

const ADMIN_PLACETYPES = new Set([
	"country", "region", "county", "locality", "localadmin",
	"borough", "neighbourhood", "macroregion", "macrocounty",
])

interface ParsedFeature {
	id: number
	parent_id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
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

function parseFeature(text: string): ParsedFeature | null {
	const feature = JSON.parse(text)
	const props = feature.properties
	if (!props) return null

	const supersededBy = props["wof:superseded_by"]
	if (supersededBy && supersededBy.length > 0) return null

	const placetype = props["wof:placetype"]
	if (!ADMIN_PLACETYPES.has(placetype)) return null

	const mzIsCurrent = props["mz:is_current"]

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
		latitude: typeof props["geom:latitude"] === "number" ? props["geom:latitude"] : 0,
		longitude: typeof props["geom:longitude"] === "number" ? props["geom:longitude"] : 0,
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
	const { dataDir, outputPath, concurrency, batchCommitSize } = parseArgs()
	const t0 = performance.now()

	console.error(`Scanning ${dataDir} for GeoJSON files...`)
	const filePaths = await FastGlob("**/*.geojson", {
		cwd: dataDir,
		absolute: true,
		ignore: ["**/*-alt-*"],
	})
	console.error(`  Found ${filePaths.length.toLocaleString()} files (excluding -alt- variants)`)

	console.error(`Creating ${outputPath}...`)
	const db = new DatabaseSync(outputPath, { open: true })
	createUnifiedSchema(db)

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, ?, ?, ?, ?)`
	)
	const concordancesInsert = db.prepare(
		`INSERT INTO concordances (id, other_id, other_source, lastmodified) VALUES (?, ?, ?, ?)`
	)
	const populationInsert = db.prepare(
		`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`
	)

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

	console.error(`Processing with concurrency=${concurrency}, batch commit every ${batchCommitSize} files...`)

	const readResults = asyncParallelIterator(
		filePaths,
		concurrency,
		(filePath) => readFile(filePath, "utf8"),
	)

	for await (const text of readResults) {
		const feature = parseFeature(text)
		if (!feature) {
			skipped++
			continue
		}

		beginIfNeeded()

		sprInsert.run(
			feature.id, feature.parent_id, feature.name, feature.placetype,
			feature.country, feature.latitude, feature.longitude,
			feature.isCurrent, feature.isDeprecated, feature.isCeased,
			feature.isSuperseded, feature.isSuperseding, feature.lastmodified
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

		if (processed % 10000 === 0) {
			const elapsed = (performance.now() - t0) / 1000
			const rate = processed / elapsed
			const eta = (filePaths.length - processed - skipped) / rate
			console.error(`  ${processed.toLocaleString()} processed, ${skipped.toLocaleString()} skipped (${rate.toFixed(0)}/s, ETA ${eta.toFixed(0)}s)`)
		}
	}

	commitIfNeeded(true)

	console.error("Creating indexes...")
	createUnifiedIndexes(db)

	db.close()

	const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
	console.error(`\nDone in ${elapsed}s:`)
	console.error(`  Processed: ${processed.toLocaleString()} admin places`)
	console.error(`  Skipped:   ${skipped.toLocaleString()} (non-admin, superseded, alt-geometry)`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
