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

import { createHash } from "node:crypto"
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { repoRootPathBuilder, sealDatabase } from "@mailwoman/core/utils"

import { mailwomanDataRoot } from "../../resolver-backend.js"
import {
	DEFAULT_ADMIN_STAGING_SUFFIX,
	DEFAULT_GEONAMES_COUNTRIES,
	DEFAULT_OVERTURE_COUNTRIES,
	DEFAULT_OVERTURE_RELEASE,
	geonamesAdminGapCountries,
} from "../defaults.js"
import { buildFTS } from "../fts.js"
import { loadDefaultBaseline, verifyAdmin, verifyReversePanel, type VerifyResult } from "../verify.js"
import { enrichAdmin } from "./enrich.js"
import { foldGeonames } from "./fold-geonames.js"
import { ingestOvertureDivisions } from "./fold-overture.js"
import { freezeAdmin } from "./freeze.js"
import { ingestWOF } from "./ingest-wof.js"

export interface BuildAdminOptions {
	/** WOF repos root. Default `<data-root>/wof/repos`. */
	dataDir?: string
	/** Output artifact path. Default `<data-root>/wof/admin-global-priority.REBUILD.db` (staging — swap deliberately). */
	out?: string
	overtureCountries?: readonly string[]
	geonamesCountries?: readonly string[]
	overtureRelease?: string
	/** Skip the verify gate (fixture/dev runs ONLY — an unverified artifact must never be promoted). */
	skipVerify?: boolean
	/** Skip the WOF geojson ingest concurrency/batch tuning. */
	concurrency?: number
	batchCommitSize?: number
	/** Build-log path. Default `<repo>/scripts/wof-build-manifest.json`; absent file → the append is skipped. */
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

/** Streamed md5 of a (multi-GB) artifact — the build-log fingerprint. */
async function fileMD5(path: string): Promise<string> {
	const hash = createHash("md5")

	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/** Run the full admin-gazetteer build. See the module docstring for the phase order and why it's fixed. */
export async function buildAdmin(opts: BuildAdminOptions = {}): Promise<BuildAdminResult> {
	const t0 = performance.now()
	const phase = opts.onPhase ?? (() => {})
	const wofDir = join(mailwomanDataRoot(), "wof")
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

	phase("ingest-wof", dataDir)
	const ingest = await ingestWOF(db, {
		dataDir,
		concurrency: opts.concurrency,
		batchCommitSize: opts.batchCommitSize,
		onProgress: (processed, skipped, total) =>
			phase(
				"ingest-wof",
				`${processed.toLocaleString()}/${total.toLocaleString()} (+${skipped.toLocaleString()} skipped)`
			),
	})
	phase("ingest-wof", `${ingest.placesIngested.toLocaleString()} places`)

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
	db.close()
	unlinkSync(ingestPath)

	for (const sidecar of [ingestPath + "-wal", ingestPath + "-shm"]) {
		if (existsSync(sidecar)) {
			unlinkSync(sidecar)
		}
	}

	phase("fts")
	const outDB = new DatabaseSync(out)
	const fts = await buildFTS(outDB, { onProgress: phase })
	outDB.close()
	phase("fts", `${fts.ftsRows.toLocaleString()} FTS rows / ${fts.bboxRows.toLocaleString()} bbox rows`)

	let verify: VerifyResult | null = null

	if (!opts.skipVerify) {
		phase("verify", "structural checks")
		const verifyDB = new DatabaseSync(out, { readOnly: true })
		const structural = verifyAdmin(verifyDB, loadDefaultBaseline())
		verifyDB.close()

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

	phase("seal")
	sealDatabase(out)

	// Build log — an auto-appended record (what ran, when, fingerprint), so the manifest can't lag the
	// artifact again (#1015's reconstruct-from-artifact). The recipe itself lives in defaults.ts.
	const buildLogPath = opts.buildLogPath ?? String(repoRootPathBuilder("scripts", "wof-build-manifest.json"))

	if (existsSync(buildLogPath)) {
		phase("build-log", buildLogPath)
		const log = JSON.parse(readFileSync(buildLogPath, "utf8")) as { notes?: string[] }
		const md5 = (await fileMD5(out)).slice(0, 8)
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
export * from "./enrich.js"
export * from "./fold-geonames.js"
export * from "./fold-overture.js"
export * from "./freeze.js"
export * from "./ingest-wof.js"

/** Byte-size of the built artifact — a convenience for command summaries. */
export function artifactSizeMB(path: string): number {
	return Math.round((statSync(path).size / 1024 / 1024) * 10) / 10
}
