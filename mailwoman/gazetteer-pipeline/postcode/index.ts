/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The WOF postcode-shard build (`postalcode-<cc>.db`) — ingest the country's
 *   `whosonfirst-data-postalcode-<cc>` repo, fill the `(0,0)` placeholder centroids (US: Census ZCTA +
 *   GeoNames; all: GeoNames postal → admin parent-borrow → hierarchy-ancestor fallback), FTS, SEAL.
 *   Replaces the reopen-and-mutate pair (`fill-zcta-centroids.ts` / `backfill-postcode-centroids.ts`)
 *   that patched shipped shards after the fact — the fills are build steps now, and the artifact is
 *   read-only from the moment it exists.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { sealDatabase } from "@mailwoman/core/utils"

import { mailwomanDataRoot } from "../../resolver-backend.js"
import { ingestWOF } from "../admin/ingest-wof.js"
import { buildFTS } from "../fts.js"
import { type CentroidFillResult, fillPostcodeCentroids } from "./centroid-fills.js"
import {
	fillGeonamesPlaceholders,
	fillPlaceholderCentroids,
	parseGeonamesCentroids,
	parseZCTACentroids,
} from "./zcta-centroids.js"

export interface BuildPostcodeShardOptions {
	/** ISO-2 country whose `whosonfirst-data-postalcode-<cc>` repo to ingest. */
	country: string
	/** WOF repos root. Default `<data-root>/wof/repos`. */
	reposDir?: string
	/** Output artifact. Default `<data-root>/wof/postalcode-<cc>.REBUILD.db` (staging — swap deliberately). */
	out?: string
	/** Census ZCTA Gazetteer file (US pass 1). Default `<data-root>/census/2024_Gaz_zcta_national.txt`. */
	zctaPath?: string
	/** GeoNames postal dump dir. Default `<data-root>/geonames-postal`. */
	geonamesPostalDir?: string
	/** Admin gazetteer for the parent/ancestor borrows. Default the live `admin-global-priority.db`. */
	adminPath?: string
	onPhase?: (phase: string, detail?: string) => void
}

export interface BuildPostcodeShardResult {
	out: string
	postcodesIngested: number
	zctaFilled: number
	geonamesUSFilled: number
	fills: CentroidFillResult
	sealed: boolean
}

/** Build one country's sealed postcode shard. See the module docstring for the fill ladder. */
export async function buildPostcodeShard(opts: BuildPostcodeShardOptions): Promise<BuildPostcodeShardResult> {
	const phase = opts.onPhase ?? (() => {})
	const cc = opts.country.toLowerCase()
	const wofDir = join(mailwomanDataRoot(), "wof")
	const reposDir = opts.reposDir ?? join(wofDir, "repos")
	const repoDir = join(reposDir, `whosonfirst-data-postalcode-${cc}`)
	const out = opts.out ?? join(wofDir, `postalcode-${cc}.REBUILD.db`)

	if (!existsSync(repoDir)) {
		throw new Error(`buildPostcodeShard: no postcode repo at ${repoDir} — clone whosonfirst-data-postalcode-${cc}`)
	}

	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const { createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const ingestPath = out + ".ingest"

	if (existsSync(ingestPath)) unlinkSync(ingestPath)

	phase("staging", ingestPath)
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

	phase("ingest", repoDir)
	const ingest = await ingestWOF(db, {
		dataDir: repoDir,
		placetypes: new Set(["postalcode"]),
		onProgress: (processed, skipped, total) =>
			phase("ingest", `${processed.toLocaleString()}/${total.toLocaleString()} (+${skipped.toLocaleString()} skipped)`),
	})
	phase("ingest", `${ingest.placesIngested.toLocaleString()} postcodes`)

	// US pass 1: Census ZCTA + GeoNames US (provenance-stamped in centroid_source; see zcta-centroids.ts).
	let zctaFilled = 0
	let geonamesUSFilled = 0

	if (cc === "us") {
		const zctaPath = opts.zctaPath ?? join(mailwomanDataRoot(), "census", "2024_Gaz_zcta_national.txt")

		if (existsSync(zctaPath)) {
			phase("fill-zcta", zctaPath)
			zctaFilled = fillPlaceholderCentroids(db, parseZCTACentroids(readFileSync(zctaPath, "utf8")))
		} else {
			phase("fill-zcta", `SKIPPED (${zctaPath} not present)`)
		}
		const usPostal = join(opts.geonamesPostalDir ?? join(mailwomanDataRoot(), "geonames-postal"), "US.txt")

		if (existsSync(usPostal)) {
			phase("fill-geonames-us", usPostal)
			geonamesUSFilled = fillGeonamesPlaceholders(db, parseGeonamesCentroids(readFileSync(usPostal, "utf8")))
		}
	}

	// The general ladder (GeoNames postal → parent-borrow → ancestor fallback).
	const fills = await fillPostcodeCentroids(db, {
		geonamesDir: opts.geonamesPostalDir ?? join(mailwomanDataRoot(), "geonames-postal"),
		adminPath: opts.adminPath ?? join(wofDir, "admin-global-priority.db"),
		reposDir,
		onPhase: phase,
	})
	phase(
		"fills",
		`${fills.placedBefore.toLocaleString()} → ${fills.placedAfter.toLocaleString()} placed of ${fills.total.toLocaleString()}`
	)

	phase("freeze")
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	db.exec("PRAGMA journal_mode = DELETE")
	db.exec("ANALYZE")

	phase("vacuum", out)

	if (existsSync(out)) unlinkSync(out)
	db.prepare("VACUUM INTO ?").run(out)
	db.close()
	unlinkSync(ingestPath)

	for (const sidecar of [ingestPath + "-wal", ingestPath + "-shm"]) {
		if (existsSync(sidecar)) unlinkSync(sidecar)
	}

	phase("fts")
	const outDB = new DatabaseSync(out)
	await buildFTS(outDB, { onProgress: phase })
	outDB.close()

	phase("seal")
	sealDatabase(out)

	return { out, postcodesIngested: ingest.placesIngested, zctaFilled, geonamesUSFilled, fills, sealed: true }
}

export * from "./centroid-fills.js"
export * from "./zcta-centroids.js"
