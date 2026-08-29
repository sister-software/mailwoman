/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The turnkey admin-gazetteer build — every step of the runbook that used to live across one script
 *   plus four separately-remembered post-build steps (the #1015 rebuild missed two of them), in one
 *   verified, sealed pipeline:
 *
 *   ingest-wof → fold-overture → fold-geonames → freeze → enrich → VACUUM INTO → FTS → VERIFY → SEAL.
 *
 *   A failed verify THROWS and leaves the artifact UNSEALED for inspection — do not swap it. On
 *   success the build appends itself to the build log (`scripts/wof-build-manifest.json` — a LOG, not
 *   a recipe; the recipe is `../defaults.ts`).
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { md5File, repoRootPath } from "@mailwoman/core/utils"
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "@mailwoman/platform/fs"
import { join } from "@mailwoman/platform/path"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"

import { dataRootPath } from "../../resolver-backend.ts"
import {
	DEFAULT_ADMIN_STAGING_SUFFIX,
	DEFAULT_GEONAMES_COUNTRIES,
	DEFAULT_OVERTURE_COUNTRIES,
	DEFAULT_OVERTURE_RELEASE,
	geonamesAdminGapCountries,
} from "../defaults.ts"
import { buildFTS } from "../fts.ts"
import { checkOvertureRelease } from "../overture-release.ts"
import { buildSHA, stampLayerManifest } from "../stamp-manifest.ts"
import { loadDefaultBaseline, verifyAdmin, verifyReversePanel, type VerifyResult } from "../verify.ts"
import { enrichAdmin } from "./enrich.ts"
import { foldGeonames } from "./fold-geonames.ts"
import { ingestOvertureDivisions } from "./fold-overture.ts"
import { freezeAdmin } from "./freeze.ts"
import { ingestWOF } from "./ingest-wof.ts"
import { createGeoNamesAnchorLookup } from "./label-point-adjudicator.ts"
import { adminLayerManifest } from "./manifest.ts"

export interface BuildAdminOptions {
	/**
	 * WOF repos root. Default `<data-root>/wof/repos`.
	 */
	dataDir?: string
	/**
	 * Output artifact path. Default `<data-root>/wof/admin-global-priority.REBUILD.db` (staging — swap deliberately).
	 */
	out?: string
	overtureCountries?: readonly string[]
	geonamesCountries?: readonly string[]
	overtureRelease?: string
	/**
	 * Skip the verify gate (fixture/dev runs ONLY — an unverified artifact must never be promoted).
	 */
	skipVerify?: boolean
	/**
	 * Skip the WOF geojson ingest concurrency/batch tuning.
	 */
	concurrency?: number
	batchCommitSize?: number
	/**
	 * Build-log path. Default `<repo>/scripts/wof-build-manifest.json`; absent file → the append is skipped.
	 */
	buildLogPath?: string
	onPhase?: (phase: string, detail?: string) => void
}

export interface BuildAdminResult {
	out: string
	placesIngested: number
	overtureIngested: number
	geonamesIngested: number
	verify: VerifyResult | null
	sealed: boolean
	elapsedSeconds: number
}

/**
 * Run the full admin-gazetteer build. See the module docstring for the phase order and why it's fixed.
 */
export async function buildAdmin(opts: BuildAdminOptions = {}): Promise<BuildAdminResult> {
	const t0 = performance.now()
	const phase = opts.onPhase ?? (() => {})
	const wofDir = dataRootPath("wof")
	const dataDir = opts.dataDir ?? join(wofDir, "repos")
	const out = opts.out ?? join(wofDir, `admin-global-priority${DEFAULT_ADMIN_STAGING_SUFFIX}`)
	const overtureCountries = opts.overtureCountries ?? DEFAULT_OVERTURE_COUNTRIES
	const geonamesCountries = opts.geonamesCountries ?? DEFAULT_GEONAMES_COUNTRIES
	const overtureRelease = opts.overtureRelease ?? DEFAULT_OVERTURE_RELEASE

	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const { createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const ingestPath = out + ".ingest"

	if (existsSync(ingestPath)) {
		unlinkSync(ingestPath)
	}

	// BEFORE the WOF ingest, not at `fold-overture` where the release is first read: a pruned pin is a one-request
	// question, and discovering it after 2.9M records reads as a network fault rather than an expired pin.
	const releaseCheck = await checkOvertureRelease(overtureRelease)

	phase("preflight", releaseCheck.message)

	if (!releaseCheck.present) throw new Error(releaseCheck.message)

	phase("staging", ingestPath)
	const db = new DatabaseClient<WOFDatabase>(ingestPath)

	db.exec(`
		PRAGMA page_size = 8192;
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 30000;
		PRAGMA temp_store = MEMORY;
		PRAGMA cache_size = -200000;
	`)

	await createUnifiedSchema(db)

	phase("ingest-wof", dataDir)

	const ingest = await ingestWOF(db, {
		dataDir,
		concurrency: opts.concurrency,
		batchCommitSize: opts.batchCommitSize,
		// #1905: GeoNames-anchored label-point adjudication. Reads the same per-country extracts fold-geonames
		// consumes; a data root without them degrades to the plain label preference.
		anchorLookup: createGeoNamesAnchorLookup(String(dataRootPath("geonames"))),
		onProgress: (processed, skipped, total) =>
			phase(
				"ingest-wof",
				`${processed.toLocaleString()}/${total.toLocaleString()} (+${skipped.toLocaleString()} skipped)`
			),
	})

	phase(
		"ingest-wof",
		`${ingest.placesIngested.toLocaleString()} places (${ingest.labelPointOverrides} label points overridden by anchor)`
	)

	phase("fold-overture", `${overtureCountries.length} countries @ ${overtureRelease}`)
	const overtureIngested = await ingestOvertureDivisions(db, overtureCountries, overtureRelease)
	phase("fold-overture", `${overtureIngested.toLocaleString()} divisions`)

	// #1026: the A-class admin fold for the zero-coverage locales — country + region NODES + locality
	// ancestry. Scoped to the countries actually in this run's geonames set.
	const gapSet = new Set(geonamesAdminGapCountries().filter((cc) => geonamesCountries.includes(cc)))
	phase("fold-geonames", `${geonamesCountries.length} countries (${gapSet.size} with admin fold)`)
	const folded = await foldGeonames(db, { countries: geonamesCountries, adminForCountries: gapSet })
	phase("fold-geonames", `${folded.placesIngested.toLocaleString()} places`)

	phase("freeze")
	await freezeAdmin(db, { dataDir, onPhase: phase })

	phase("enrich")
	const enriched = enrichAdmin(db)
	phase("enrich", `${enriched.abbrevNamesAdded} abbrevs / ${enriched.placeAbbrRows} place_abbr rows`)

	phase("vacuum", out)

	if (existsSync(out)) {
		// A prior sealed staging artifact can't be unlinked-through-write — remove it explicitly.
		unlinkSync(out)
	}

	db.prepare("VACUUM INTO ?").run(out)
	await db.destroy()
	unlinkSync(ingestPath)

	for (const sidecar of [ingestPath + "-wal", ingestPath + "-shm"]) {
		if (existsSync(sidecar)) {
			unlinkSync(sidecar)
		}
	}

	phase("fts")
	const outDB = new DatabaseClient<WOFDatabase>(out)
	const fts = await buildFTS(outDB, { onProgress: phase })
	await outDB.destroy()
	phase("fts", `${fts.ftsRows.toLocaleString()} FTS rows / ${fts.bboxRows.toLocaleString()} bbox rows`)

	let verify: VerifyResult | null = null

	if (!opts.skipVerify) {
		phase("verify", "structural checks")
		const verifyDB = new DatabaseClient<WOFDatabase>(out, { readOnly: true })
		const structural = verifyAdmin(verifyDB, loadDefaultBaseline())
		await verifyDB.destroy()

		phase("verify", "reverse panel")
		const reverse = await verifyReversePanel(out)
		verify = { ok: structural.ok && reverse.ok, checks: [...structural.checks, ...reverse.checks] }

		for (const c of verify.checks) {
			phase("verify", `${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`)
		}

		if (!verify.ok) {
			const failed = verify.checks.filter((c) => !c.ok).map((c) => c.check)
			throw new Error(
				`buildAdmin: verify FAILED (${failed.join(", ")}) — the artifact at ${out} is left UNSEALED for inspection. Do not swap it.`
			)
		}
	}

	// BEFORE the seal — see `stampLayerManifest`, which owns that ordering and its reason.
	phase("manifest")
	const sha = buildSHA(String(repoRootPath()))

	await stampLayerManifest(
		out,
		adminLayerManifest({
			// The counts the build actually produced, not the lists it was given. A fold that ingested
			// nothing must not appear as a source — see manifest.ts.
			counts: { wof: ingest.placesIngested, overture: overtureIngested, geonames: folded.placesIngested },
			buildSHA: sha,
			vintages: { overture: overtureRelease },
			version: new Date().toISOString().slice(0, 10),
			createdAt: new Date().toISOString(),
		})
	)

	phase("manifest", "layer_manifest written")

	phase("seal")
	sealDatabase(out)

	// Build log — an auto-appended record (what ran, when, fingerprint), so the manifest can't lag the
	// artifact again (#1015's reconstruct-from-artifact). The recipe itself lives in defaults.ts.
	const buildLogPath = opts.buildLogPath ?? repoRootPath("scripts", "wof-build-manifest.json")

	if (existsSync(buildLogPath)) {
		phase("build-log", buildLogPath)
		const log = parseJSONStrict<{ notes?: string[] }>(readFileSync(buildLogPath, "utf8"))
		const md5 = (await md5File(out)).slice(0, 8)
		const stamp = new Date().toISOString().slice(0, 10)
		log.notes ??= []

		log.notes.push(
			`${stamp}: gazetteer build admin — ${ingest.placesIngested.toLocaleString()} WOF + ${overtureIngested.toLocaleString()} overture@${overtureRelease} + ${folded.placesIngested.toLocaleString()} geonames; verify ${opts.skipVerify ? "SKIPPED" : "PASS"}; sealed; md5 ${md5}; ${out}`
		)

		writeFileSync(buildLogPath, JSON.stringify(log, null, "\t") + "\n")
	} else {
		phase("build-log", `skipped (${buildLogPath} not present)`)
	}

	return {
		out,
		placesIngested: ingest.placesIngested,
		overtureIngested,
		geonamesIngested: folded.placesIngested,
		verify,
		sealed: true,
		elapsedSeconds: Math.round((performance.now() - t0) / 100) / 10,
	}
}

// Re-export the step functions so `gazetteer-pipeline/admin` is a complete surface on its own.
export * from "./enrich.ts"
export * from "./fold-geonames.ts"
export * from "./fold-overture.ts"
export * from "./freeze.ts"
export * from "./ingest-wof.ts"

/**
 * Byte-size of the built artifact — a convenience for command summaries.
 */
export function artifactSizeMB(path: string): number {
	return Math.round((statSync(path).size / 1024 / 1024) * 10) / 10
}
