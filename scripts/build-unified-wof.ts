/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a unified WOF SQLite database from cloned GeoJSON repos — now a thin CLI over the
 *   `mailwoman/gazetteer-pipeline` module (ingest-wof → fold-overture → fold-geonames → freeze),
 *   which is where the implementation lives. SUPERSEDED by `mailwoman gazetteer build admin`
 *   (which adds the enrich/FTS/verify/seal steps this script never had); kept only until the
 *   command lands — see docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md.
 *
 *   Usage: node scripts/build-unified-wof.ts\
 *   --data /mnt/playpen/mailwoman-data/wof/repos\
 *   --output <staging.db>\
 *   [--overture-countries …] [--geonames-countries …] [--overture-release 2026-06-17.0]
 */

import { existsSync, statSync, unlinkSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath, sealDatabase } from "@mailwoman/core/utils"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import {
	DEFAULT_OVERTURE_RELEASE,
	foldGeonames,
	freezeAdmin,
	ingestOvertureDivisions,
	ingestWOF,
} from "mailwoman/gazetteer-pipeline"

interface Args {
	dataDir: string
	outputPath: string
	concurrency: number
	batchCommitSize: number
	/** Override the ingested placetype set; pass `--placetypes postalcode` for the postcode shard. */
	placetypes?: string[]
	overtureCountries?: string[]
	overtureRelease: string
	geonamesCountries?: string[]
	geonamesPostalCountries?: string[]
	geonamesPostalDir: string
	geonamesDir: string
	geonamesAlternateDir: string
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
	let geonamesCountries: string[] | undefined
	let geonamesDir = String(dataRootPath("geonames"))
	let geonamesPostalCountries: string[] | undefined
	let geonamesPostalDir = String(dataRootPath("geonames-postal"))
	let geonamesAlternateDir = String(dataRootPath("geonames-alternate"))

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
		else if (args[i] === "--geonames-countries" && args[i + 1])
			geonamesCountries = args[++i]!.split(",")
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean)
		else if (args[i] === "--geonames-dir" && args[i + 1]) geonamesDir = args[++i]!
		else if (args[i] === "--geonames-postal-countries" && args[i + 1]) geonamesPostalCountries = args[++i]!.split(",")
		else if (args[i] === "--geonames-postal-dir" && args[i + 1]) geonamesPostalDir = args[++i]!
		else if (args[i] === "--geonames-alternate-dir" && args[i + 1]) geonamesAlternateDir = args[++i]!
	}

	if (!dataDir || !outputPath) {
		console.error(
			"Usage: node scripts/build-unified-wof.ts --data <wof-repos-dir> --output <output.db> [--concurrency 64] [--batch 500] [--placetypes postalcode] [--overture-countries PT,PL,CZ] [--overture-release 2026-06-17.0] [--geonames-countries FI,EE,LV] [--geonames-dir <dir>]  — SUPERSEDED by `mailwoman gazetteer build admin`"
		)
		process.exit(1)
	}

	return {
		dataDir,
		outputPath,
		concurrency,
		batchCommitSize,
		placetypes,
		overtureCountries,
		overtureRelease,
		geonamesCountries,
		geonamesDir,
		geonamesPostalCountries,
		geonamesPostalDir,
		geonamesAlternateDir,
	}
}

async function main() {
	const args = parseArgs()
	const t0 = performance.now()
	const ingestPath = args.outputPath + ".ingest"

	if (existsSync(ingestPath)) unlinkSync(ingestPath)

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
	await createUnifiedSchema(db)

	console.error(`Scanning + ingesting WOF GeoJSON from ${args.dataDir}...`)
	const ingest = await ingestWOF(db, {
		dataDir: args.dataDir,
		placetypes: args.placetypes ? new Set(args.placetypes) : undefined,
		concurrency: args.concurrency,
		batchCommitSize: args.batchCommitSize,
		onProgress: (processed, skipped, total) => {
			const elapsed = (performance.now() - t0) / 1000
			const rate = processed / elapsed
			const eta = (total - processed - skipped) / rate
			console.error(
				`  ${processed.toLocaleString()} processed, ${skipped.toLocaleString()} skipped (${rate.toFixed(0)}/s, ETA ${eta.toFixed(0)}s)`
			)
		},
	})
	console.error(
		`Ingest complete: ${ingest.placesIngested.toLocaleString()} places, ${ingest.skipped.toLocaleString()} skipped`
	)

	let overtureIngested = 0

	if (args.overtureCountries && args.overtureCountries.length > 0) {
		console.error(`Backfilling Overture divisions for ${args.overtureCountries.join(",")}...`)
		overtureIngested = await ingestOvertureDivisions(db, args.overtureCountries, args.overtureRelease)
		console.error(`  Overture divisions ingested: ${overtureIngested.toLocaleString()}`)
	}

	if (args.geonamesCountries && args.geonamesCountries.length > 0) {
		console.error(`Backfilling GeoNames aliases for ${args.geonamesCountries.join(",")}...`)
		const folded = foldGeonames(db, {
			countries: args.geonamesCountries,
			geonamesDir: args.geonamesDir,
			alternateDir: args.geonamesAlternateDir,
			postalCountries: args.geonamesPostalCountries,
			postalDir: args.geonamesPostalDir,
		})
		console.error(
			`  GeoNames places ingested: ${folded.placesIngested.toLocaleString()} (+${folded.postalIngested.toLocaleString()} postal)`
		)
	}

	console.error("Freezing...")
	const frozen = await freezeAdmin(db, {
		dataDir: args.dataDir,
		onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
	})
	console.error(`  ancestors: ${frozen.ancestorRows} rows; coincident_roles: ${frozen.coincidentRoles}`)

	if (existsSync(args.outputPath)) {
		const s = statSync(args.outputPath)

		if (s.size > 0) unlinkSync(args.outputPath)
	}
	db.prepare("VACUUM INTO ?").run(args.outputPath)
	console.error(`  VACUUM INTO ${args.outputPath}`)

	db.close()
	unlinkSync(ingestPath)

	for (const sidecar of [ingestPath + "-wal", ingestPath + "-shm"]) {
		if (existsSync(sidecar)) unlinkSync(sidecar)
	}

	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	sealDatabase(args.outputPath)
	console.error("  sealed 0444")

	const finalSize = (statSync(args.outputPath).size / 1024 / 1024).toFixed(1)
	const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1)
	console.error(`\nDone in ${totalElapsed}s:`)
	console.error(`  Places:  ${ingest.placesIngested.toLocaleString()}`)

	if (overtureIngested > 0) console.error(`  Overture: ${overtureIngested.toLocaleString()}`)
	console.error(`  Skipped: ${ingest.skipped.toLocaleString()}`)
	console.error(`  Output:  ${args.outputPath} (${finalSize} MB)`)
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err)
		process.exit(1)
	})
}
