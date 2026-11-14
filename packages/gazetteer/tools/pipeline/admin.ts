// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The turnkey admin-gazetteer build — the runbook phases in one verified, sealed pipeline:
 *
 *   ingest-wof → fold-overture → fold-geonames → freeze → enrich → vacuum into → FTS → verify → seal.
 *
 *   A failed verify throws and leaves the artifact unsealed for inspection — do not swap it.
 *   On success the build appends itself to the build log (`data/gazetteer/wof-build-manifest.json`,
 *   a log rather than a recipe. The recipe is `../defaults.ts`).
 */

import { dataRootPath, wofReposPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { removePath, writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { repoRootPath } from "@mailwoman/core/paths"
import { createPhaseClock, formatPhaseTimings, isoDate, type PhaseTiming } from "@mailwoman/core/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed/db"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { enrichAdmin } from "#tools/pipeline/admin/enrich"
import { foldGeonames, type FoldGeonamesResult } from "#tools/pipeline/admin/fold/geonames"
import { ingestOvertureDivisions } from "#tools/pipeline/admin/fold/overture"
import { buildWOFPlaceIndex, type FoldGap } from "#tools/pipeline/admin/fold/wof-match"
import { freezeAdmin } from "#tools/pipeline/admin/freeze"
import { ingestWOF, type IngestWOFResult } from "#tools/pipeline/admin/ingest-wof"
import { fingerprintAdminInputs } from "#tools/pipeline/admin/inputs"
import { createGeoNamesAnchorLookup } from "#tools/pipeline/admin/label-point-adjudicator"
import { adminLayerManifest, type IngestCounts } from "#tools/pipeline/admin/manifest"
import {
	DEFAULT_ADMIN_STAGING_SUFFIX,
	DEFAULT_GEONAMES_COUNTRIES,
	DEFAULT_OVERTURE_COUNTRIES,
	geonamesAdminGapCountries,
} from "#tools/pipeline/defaults"
import { buildFTS, type BuildFTSResult } from "#tools/pipeline/fts"
import { checkOvertureRelease } from "#tools/pipeline/overture-release"
import { DEFAULT_RELEASE as DEFAULT_OVERTURE_RELEASE } from "#tools/pipeline/poi/defaults"
import { buildSHA, stampLayerManifest } from "#tools/pipeline/stamp-manifest"
import { loadDefaultBaseline, verifyAdmin, verifyReversePanel, type VerifyResult } from "#tools/pipeline/verify"

export interface BuildAdminOptions {
	/**
	 * WOF repos root.
	 *
	 * @defaultValue `$MAILWOMAN_CACHE_ROOT/sources/wof-repos`
	 */
	dataDir?: PathBuilderLike
	/**
	 * Output artifact path.
	 *
	 * @defaultValue `<data-root>/db/wof/admin-global-priority.rebuild.db` (staging — swap deliberately).
	 */
	out?: PathBuilderLike
	overtureCountries?: readonly string[] | null
	geonamesCountries?: readonly string[] | null
	overtureRelease?: string
	/**
	 * Skip the verify step (fixture/dev runs only — an unverified artifact must never be promoted).
	 */
	skipVerify?: boolean
	/**
	 * The number of WOF records per ingest write transaction.
	 */
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
	/**
	 * Each phase's wall-clock seconds through the seal, in the order the phases first ran.
	 */
	phaseSeconds: PhaseTiming[]
}

/**
 * Run the full admin-gazetteer build.
 *
 * The module docstring holds the phase order and why it is fixed.
 */
export async function buildAdmin(opts: BuildAdminOptions = {}): Promise<BuildAdminResult> {
	const t0 = performance.now()
	const clock = createPhaseClock()

	const phase = (name: string, detail?: string) => {
		clock.mark(name)
		opts.onPhase?.(name, detail)
	}

	const dataDir = PathBuilder.from(opts.dataDir ?? wofReposPath)
	const out = PathBuilder.from(opts.out ?? wofDatabasePath(`admin-global-priority${DEFAULT_ADMIN_STAGING_SUFFIX}`))
	const overtureCountries = opts.overtureCountries ?? DEFAULT_OVERTURE_COUNTRIES
	const geonamesCountries = opts.geonamesCountries ?? DEFAULT_GEONAMES_COUNTRIES
	const overtureRelease = opts.overtureRelease ?? DEFAULT_OVERTURE_RELEASE

	// Imported here so loading this module doesn't evaluate resolver-wof-sqlite (the gazetteer-pipeline convention).
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

	// Read before the ingest, so the manifest states the inputs this build read.
	phase("inputs", "fingerprinting the WOF clones and the GeoNames files")

	const inputs = await fingerprintAdminInputs({
		dataDir,
		geonamesCountries,
		geonamesDir: dataRootPath("geonames"),
		alternateDir: dataRootPath("geonames-alternate"),
	})

	phase("inputs", `whosonfirst=${inputs.wof} geonames=${inputs.geonames}`)
	phase("staging", ingestPath)

	let ingest: IngestWOFResult

	let overtureIngested: number

	let folded: FoldGeonamesResult

	const gaps: FoldGap[] = []

	/**
	 * The `names` and `concordances` rows each source wrote, read back from the staging database.
	 */
	const contributed: IngestCounts = { wof: 0, overture: 0, geonames: 0 }

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
			batchCommitSize: opts.batchCommitSize,
			onRepo: (refresh) => {
				if (refresh.action === "reduced") {
					phase("ingest-wof", `record store: reduced ${refresh.repo} (${refresh.records.toLocaleString()} records)`)
				}
			},
			// GeoNames-anchored label-point adjudication.
			// Reads the same per-country extracts that fold-geonames consumes.
			// A data root without them degrades to the plain label preference.
			anchorLookup: await createGeoNamesAnchorLookup(dataRootPath("geonames")),
			onProgress: (processed, skipped, found) =>
				phase(
					"ingest-wof",
					`${processed.toLocaleString()} ingested, ${skipped.toLocaleString()} skipped, of ${found.toLocaleString()} records read so far`
				),
		})

		phase(
			"ingest-wof",
			`${ingest.placesIngested.toLocaleString()} places (${ingest.labelPointOverrides} label points overridden by anchor)`
		)

		// WOF holds every place it has a record of.
		// A folded place that matches a WOF record adds its names to that record,
		// and one that matches none is written and listed as a gap.
		phase("match-index", "indexing WOF records for the folds")
		const index = buildWOFPlaceIndex(db)
		const wof = { index, onGap: (gap: FoldGap) => void gaps.push(gap) }

		phase("fold-overture", `${overtureCountries.length} countries @ ${overtureRelease}`)
		overtureIngested = await ingestOvertureDivisions(db, overtureCountries, overtureRelease, undefined, wof)
		phase("fold-overture", `${overtureIngested.toLocaleString()} divisions written as their own rows`)

		// The A-class admin fold for the zero-coverage locales — country + region nodes +
		// locality ancestry — scoped to the countries in this run's geonames set.
		const gapSet = new Set(geonamesAdminGapCountries().filter((cc) => geonamesCountries.includes(cc)))
		phase("fold-geonames", `${geonamesCountries.length} countries (${gapSet.size} with admin fold)`)
		folded = await foldGeonames(db, { countries: geonamesCountries, adminForCountries: gapSet, wof })
		phase("fold-geonames", `${folded.placesIngested.toLocaleString()} places written as their own rows`)

		index.dispose()

		// A fold that matched every place it read writes no row of its own, only names on WOF
		// records, so the manifest's sources are the row sources the database holds.
		for (const { source, rows } of db
			.prepare(
				`SELECT source, sum(n) AS rows FROM (
				   SELECT source, count(*) AS n FROM names GROUP BY source
				   UNION ALL SELECT source, count(*) AS n FROM concordances GROUP BY source
				 ) GROUP BY source`
			)
			.all() as Array<{ source: string; rows: number }>) {
			if (source === "wof" || source === "overture" || source === "geonames") {
				contributed[source] = rows
			}
		}

		const gapsPath = `${out}.fold-gaps.jsonl`

		await writeLocalJSONLFile(gaps, gapsPath)
		phase("fold-gaps", `${gaps.length.toLocaleString()} folded places match no WOF record → ${gapsPath}`)

		// The fork worklist holds only the gaps whose source's data may enter WOF.
		const candidates = gaps.filter((gap) => gap.upstreamEligible)
		const candidatesPath = `${out}.wof-candidates.jsonl`

		await writeLocalJSONLFile(candidates, candidatesPath)
		phase("fold-gaps", `${candidates.length.toLocaleString()} of them may enter the WOF forks → ${candidatesPath}`)

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
			// The counts the build produced rather than the lists it was given, so a fold
			// that ingested no places doesn't appear as a source — see manifest.ts.
			counts: contributed,
			buildSHA: sha,
			vintages: { overture: overtureRelease, wof: inputs.wof, geonames: inputs.geonames },
			// The newest input's date, so two builds from the same inputs stamp the same manifest.
			version: inputs.newestInputDate.slice(0, 10),
			createdAt: inputs.newestInputDate,
		})
	)

	phase("manifest", "layer_manifest written")

	phase("seal")
	await sealDatabase(out)

	// Build log — an auto-appended record of what ran, when and its fingerprint.
	// so the manifest cannot lag the artifact.
	// The recipe itself lives in defaults.ts.
	const buildLogPath = opts.buildLogPath ?? repoRootPath("data", "gazetteer", "wof-build-manifest.json")
	const phaseSeconds = clock.finish()

	if (await pathExists(buildLogPath)) {
		phase("build-log", buildLogPath)
		const log = await readLocalJSONFile<{ notes?: string[] }>(buildLogPath)
		const md5 = (await md5File(out)).slice(0, 8)
		const stamp = isoDate()
		const timings = formatPhaseTimings(phaseSeconds)
		log.notes ??= []

		log.notes.push(
			`${stamp}: gazetteer build admin — ${ingest.placesIngested.toLocaleString()} WOF + ${overtureIngested.toLocaleString()} overture@${overtureRelease} + ${folded.placesIngested.toLocaleString()} geonames; verify ${opts.skipVerify ? "SKIPPED" : "PASS"}; sealed; md5 ${md5}; ${out}; phases: ${timings}`
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
		phaseSeconds,
	}
}
