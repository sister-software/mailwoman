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

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { removePath } from "@mailwoman/core/fs/writers"
import { resolveWOFRepo, wofRepoName } from "@mailwoman/core/resources/whosonfirst"
import { join } from "@mailwoman/platform/path"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"

import { dataRootPath } from "../../resolver-backend.ts"
import { ingestWOF, type IngestWOFResult } from "../admin/ingest-wof.ts"
import { buildFTS } from "../fts.ts"
import { type CentroidFillResult, fillPostcodeCentroids } from "./centroid-fills.ts"
import {
	fillGeonamesPlaceholders,
	fillPlaceholderCentroids,
	parseGeonamesCentroids,
	parseZCTACentroids,
} from "./zcta-centroids.ts"

export interface BuildPostcodeShardOptions {
	/**
	 * ISO-2 country whose `whosonfirst-data-postalcode-<cc>` repo to ingest.
	 */
	country: string
	/**
	 * WOF repos root. Default `<data-root>/wof/repos`.
	 */
	reposDir?: string
	/**
	 * Output artifact. Default `<data-root>/wof/postalcode-<cc>.REBUILD.db` (staging — swap deliberately).
	 */
	out?: string
	/**
	 * Census ZCTA Gazetteer file (US pass 1). Default `<data-root>/census/2024_Gaz_zcta_national.txt`.
	 */
	zctaPath?: string
	/**
	 * GeoNames postal dump dir. Default `<data-root>/geonames-postal`.
	 */
	geonamesPostalDir?: string
	/**
	 * Admin gazetteer for the parent/ancestor borrows. Default the live `admin-global-priority.db`.
	 */
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

/**
 * Build one country's sealed postcode shard. See the module docstring for the fill ladder.
 */
export async function buildPostcodeShard(opts: BuildPostcodeShardOptions): Promise<BuildPostcodeShardResult> {
	const phase = opts.onPhase ?? (() => {})
	const cc = opts.country.toLowerCase()
	const wofDir = dataRootPath("wof")
	const reposDir = opts.reposDir ?? join(wofDir, "repos")
	const repoName = wofRepoName("postalcode", cc)
	const repoDir = await resolveWOFRepo(reposDir, repoName)
	const out = opts.out ?? join(wofDir, `postalcode-${cc}.REBUILD.db`)

	if (!repoDir) {
		throw new Error(
			`buildPostcodeShard: no ${repoName} under ${reposDir} — ` +
				`clone it with \`mailwoman gazetteer inspect sync --countries ${cc}\``
		)
	}

	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const { createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const ingestPath = out + ".ingest"

	if (await pathExists(ingestPath)) {
		await removePath(ingestPath)
	}

	phase("staging", ingestPath)

	let geonamesUSFilled = 0
	let zctaFilled = 0

	let ingest: IngestWOFResult

	let fills: CentroidFillResult

	{
		using db = new DatabaseClient<WOFDatabase>(ingestPath)

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

		ingest = await ingestWOF(db, {
			dataDir: repoDir,
			placetypes: new Set(["postalcode"]),
			onProgress: (processed, skipped, total) =>
				phase(
					"ingest",
					`${processed.toLocaleString()}/${total.toLocaleString()} (+${skipped.toLocaleString()} skipped)`
				),
		})

		phase("ingest", `${ingest.placesIngested.toLocaleString()} postcodes`)

		// US pass 1: Census ZCTA + GeoNames US (provenance-stamped in centroid_source; see zcta-centroids.ts).

		if (cc === "us") {
			const zctaPath = opts.zctaPath ?? dataRootPath("census", "2024_Gaz_zcta_national.txt")

			if (await pathExists(zctaPath)) {
				phase("fill-zcta", zctaPath)
				zctaFilled = fillPlaceholderCentroids(db, parseZCTACentroids(await readLocalTextFile(zctaPath)))
			} else {
				phase("fill-zcta", `SKIPPED (${zctaPath} not present)`)
			}

			const usPostal = join(opts.geonamesPostalDir ?? dataRootPath("geonames-postal"), "US.txt")

			if (await pathExists(usPostal)) {
				phase("fill-geonames-us", usPostal)
				geonamesUSFilled = fillGeonamesPlaceholders(db, parseGeonamesCentroids(await readLocalTextFile(usPostal)))
			}
		}

		// The general ladder (GeoNames postal → parent-borrow → ancestor fallback).
		fills = await fillPostcodeCentroids(db, {
			geonamesDir: opts.geonamesPostalDir ?? dataRootPath("geonames-postal"),
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

		if (await pathExists(out)) {
			await removePath(out)
		}

		db.prepare("VACUUM INTO ?").run(out)
	}

	await removePath(ingestPath)

	for (const sidecar of [ingestPath + "-wal", ingestPath + "-shm"]) {
		if (await pathExists(sidecar)) {
			await removePath(sidecar)
		}
	}

	phase("fts")

	{
		using outDB = new DatabaseClient<WOFDatabase>(out)
		await buildFTS(outDB, { onProgress: phase })
	}

	phase("seal")
	await sealDatabase(out)

	return { out, postcodesIngested: ingest.placesIngested, zctaFilled, geonamesUSFilled, fills, sealed: true }
}

export * from "./binary.ts"
export * from "./centroid-fills.ts"
export * from "./geonames-tail.ts"
export * from "./zcta-centroids.ts"
