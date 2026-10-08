/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The turnkey admin-gazetteer build — the runbook phases in one verified, sealed pipeline:
 *
 *   ingest-wof → fold-overture → fold-geonames → freeze → enrich → vacuum into → FTS → verify → seal.
 *
 *   A failed verify throws and leaves the artifact unsealed for inspection — do not swap it. On success
 *   the build appends itself to the build log (`data/gazetteer/wof-build-manifest.json`, a log rather
 *   than a recipe. The recipe is `../defaults.ts`).
 */

import { dataRootPath, wofReposPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { removePath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { repoRootPath } from "@mailwoman/core/paths"
import { isoDate } from "@mailwoman/core/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed/db"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { enrichAdmin } from "#gazetteer/admin/enrich"
import { foldGeonames, type FoldGeonamesResult } from "#gazetteer/admin/fold/geonames"
import { ingestOvertureDivisions } from "#gazetteer/admin/fold/overture"
import { freezeAdmin } from "#gazetteer/admin/freeze"
import { ingestWOF, type IngestWOFResult } from "#gazetteer/admin/ingest-wof"
import { createGeoNamesAnchorLookup } from "#gazetteer/admin/label-point-adjudicator"
import { adminLayerManifest } from "#gazetteer/admin/manifest"
import {
	DEFAULT_ADMIN_STAGING_SUFFIX,
	DEFAULT_GEONAMES_COUNTRIES,
	DEFAULT_OVERTURE_COUNTRIES,
	DEFAULT_OVERTURE_RELEASE,
	geonamesAdminGapCountries,
} from "#gazetteer/defaults"
import { buildFTS, type BuildFTSResult } from "#gazetteer/fts"
import { checkOvertureRelease } from "#gazetteer/overture-release"
import { buildSHA, stampLayerManifest } from "#gazetteer/stamp-manifest"
import { loadDefaultBaseline, verifyAdmin, verifyReversePanel, type VerifyResult } from "#gazetteer/verify"

export interface BuildAdminOptions {
	/**
	 * WOF repos root.
	 *
	 * @defaultValue `<data-root>/src/wof-repos`
	 */
	dataDir?: PathBuilderLike
	/**
	 * Output artifact path.
	 *
	 * @defaultValue `<data-root>/db/wof/admin-global-priority.rebuild.db` (staging — swap deliberately).
	 */
	out?: PathBuilderLike
	overtureCountries?: readonly string[]
	geonamesCountries?: readonly string[]
	overtureRelease?: string
	/**
	 * Skip the verify step (fixture/dev runs only — an unverified artifact must never be promoted).
	 */
	skipVerify?: boolean
	/**
	 * Skip the WOF geojson ingest concurrency/batch tuning.
	 */
	concurrency?: number
	batchCommitSize?: number
	/**
	 * Build-log path.
	 *
	 * @defaultValue `<repo>/data/gazetteer/wof-build-manifest.json`; absent file → the append is skipped.
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
 * Run the full admin-gazetteer build.
 *
 * The module docstring holds the phase order and why it is fixed.
 */
export async function buildAdmin(opts: BuildAdminOptions = {}): Promise<BuildAdminResult> {
	const t0 = performance.now()
	const phase = opts.onPhase ?? (() => {})
	const dataDir = PathBuilder.from(opts.dataDir ?? wofReposPath)
	const out = PathBuilder.from(opts.out ?? wofDatabasePath(`admin-global-priority${DEFAULT_ADMIN_STAGING_SUFFIX}`))
	const overtureCountries = opts.overtureCountries ?? DEFAULT_OVERTURE_COUNTRIES
	const geonamesCountries = opts.geonamesCountries ?? DEFAULT_GEONAMES_COUNTRIES
	const overtureRelease = opts.overtureRelease ?? DEFAULT_OVERTURE_RELEASE

	// Imported here so loading this module does not evaluate resolver-wof-sqlite (the gazetteer-pipeline convention).
	const { createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const ingestPath = out + ".ingest"

	if (await pathExists(ingestPath)) {
		await removePath(ingestPath)
	}

	// Check before the WOF ingest rather than at `fold-overture`.
	// A pruned pin is a one-request question.
	// A release check after 2.9M records could look like a network fault instead of an expired pin.
	const releaseCheck = await checkOvertureRelease(overtureRelease)

	phase("preflight", releaseCheck.message)

	if (!releaseCheck.present) throw new Error(releaseCheck.message)

	phase("staging", ingestPath)

	let ingest: IngestWOFResult

	let overtureIngested: number

	let folded: FoldGeonamesResult

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

		phase("ingest-wof", dataDir.toString())

		ingest = await ingestWOF(db, {
			dataDir,
			concurrency: opts.concurrency,
			batchCommitSize: opts.batchCommitSize,
			// GeoNames-anchored label-point adjudication.
			// Reads the same per-country extracts that fold-geonames consumes.
			// A data root without them degrades to the plain label preference.
			anchorLookup: await createGeoNamesAnchorLookup(dataRootPath("geonames")),
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
		overtureIngested = await ingestOvertureDivisions(db, overtureCountries, overtureRelease)
		phase("fold-overture", `${overtureIngested.toLocaleString()} divisions`)

		// The A-class admin fold for the zero-coverage locales — country + region nodes +
		// locality ancestry — scoped to the countries actually in this run's geonames set.
		const gapSet = new Set(geonamesAdminGapCountries().filter((cc) => geonamesCountries.includes(cc)))
		phase("fold-geonames", `${geonamesCountries.length} countries (${gapSet.size} with admin fold)`)
		folded = await foldGeonames(db, { countries: geonamesCountries, adminForCountries: gapSet })
		phase("fold-geonames", `${folded.placesIngested.toLocaleString()} places`)

		phase("freeze")
		await freezeAdmin(db, { dataDir, onPhase: phase })

		phase("enrich")
		const enriched = await enrichAdmin(db)
		phase("enrich", `${enriched.abbrevNamesAdded} abbrevs / ${enriched.placeAbbrRows} place_abbr rows`)

		phase("vacuum", out.toString())

		if (await pathExists(out)) {
			// A prior sealed staging artifact can't be unlinked-through-write — remove it explicitly.
			await removePath(out)
		}

		db.prepare("VACUUM INTO ?").run(out.toString())
	}

	await removePath(ingestPath)

	for (const sidecar of [ingestPath + "-wal", ingestPath + "-shm"]) {
		if (await pathExists(sidecar)) {
			await removePath(sidecar)
		}
	}

	phase("fts")

	let fts: BuildFTSResult

	{
		using outDB = new DatabaseClient<WOFDatabase>(out)
		fts = await buildFTS(outDB, { onProgress: phase })
	}

	phase("fts", `${fts.ftsRows.toLocaleString()} FTS rows / ${fts.bboxRows.toLocaleString()} bbox rows`)

	let verify: VerifyResult | null = null

	if (!opts.skipVerify) {
		phase("verify", "structural checks")
		using verifyDB = new DatabaseClient<WOFDatabase>(out, { readOnly: true })
		const structural = verifyAdmin(verifyDB, loadDefaultBaseline())

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

	// Before the seal — see `stampLayerManifest`, which owns that ordering and its reason.
	phase("manifest")
	const sha = buildSHA(repoRootPath())

	await stampLayerManifest(
		out,
		adminLayerManifest({
			// The counts the build actually produced rather than the lists it was given,
			// so a fold that ingested no places does not appear as a source — see manifest.ts.
			counts: { wof: ingest.placesIngested, overture: overtureIngested, geonames: folded.placesIngested },
			buildSHA: sha,
			vintages: { overture: overtureRelease },
			version: isoDate(),
			createdAt: new Date().toISOString(),
		})
	)

	phase("manifest", "layer_manifest written")

	phase("seal")
	await sealDatabase(out)

	// Build log — an auto-appended record of what ran, when and its fingerprint.
	// so the manifest cannot lag the artifact.
	// The recipe itself lives in defaults.ts.
	const buildLogPath = opts.buildLogPath ?? repoRootPath("data", "gazetteer", "wof-build-manifest.json")

	if (await pathExists(buildLogPath)) {
		phase("build-log", buildLogPath)
		const log = await readLocalJSONFile<{ notes?: string[] }>(buildLogPath)
		const md5 = (await md5File(out)).slice(0, 8)
		const stamp = isoDate()
		log.notes ??= []

		log.notes.push(
			`${stamp}: gazetteer build admin — ${ingest.placesIngested.toLocaleString()} WOF + ${overtureIngested.toLocaleString()} overture@${overtureRelease} + ${folded.placesIngested.toLocaleString()} geonames; verify ${opts.skipVerify ? "SKIPPED" : "PASS"}; sealed; md5 ${md5}; ${out}`
		)

		await writeLocalJSONFile(log, buildLogPath)
	} else {
		phase("build-log", `skipped (${buildLogPath} not present)`)
	}

	return {
		out: out.toString(),
		placesIngested: ingest.placesIngested,
		overtureIngested,
		geonamesIngested: folded.placesIngested,
		verify,
		sealed: true,
		elapsedSeconds: Math.round((performance.now() - t0) / 100) / 10,
	}
}
