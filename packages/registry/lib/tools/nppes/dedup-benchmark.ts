/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Build a varied multi-record set per NPI from real data, run the matcher blind to the NPI, and score the recovered clusters against the NPI grouping.
 *
 * Run: `mailwoman registry scorer-eval nppes-benchmark [--state TX] [--max-npis 300] [--wof <admin.db>] [--data-root <dir>] [--no-train-em] [--out-md docs/articles/evals/matcher-dedup/<date>-nppes-dedup-benchmark.md]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import type { GBT } from "@mailwoman/match"
import { resolvePath } from "path-ts"

import {
	ingestRows,
	resolveEntities,
	type ColumnMapping,
	type GeocodeAddress,
	type ResolvedEntity,
	type SourceRecord,
} from "#index"
import type { EvalGeocodeStream, EvalGeocoderFactory } from "#tools/eval-geocoder"
import { writeOvermergePacket } from "#tools/nppes/overmerge-packet"
import { renderNPPESDedupReport, type SweepArm } from "#tools/nppes/report"
import { buildNPPESSample } from "#tools/nppes/sample"
import { scoreEntities, type Score } from "#tools/nppes/scoring"
import { buildSettings } from "#tools/nppes/settings"
import {
	buildOrgNameCoordGrain,
	buildOrgNameGrain,
	buildOrgNameH3Grain,
	collectPrimaryCoordinates,
	type TruthLabel,
} from "#tools/nppes/truth-grains"
import { stateOption } from "#tools/shared"

/**
 * Options for {@linkcode nppesDedupBenchmark}.
 */
export interface NPPESDedupBenchmarkOptions {
	/**
	 * The injected geocoder factory, wired by the command to `mailwoman/geocode-core`; model-swap
	 * overrides (`--model`/`--tokenizer`/`--model-card`) are its factory config rather than tool options.
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * The threaded geocode surface — required when {@linkcode parallelGeocode} is set.
	 */
	geocodeStream?: EvalGeocodeStream
	/**
	 * Record-matcher sources directory, defaulting to `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * State filter, default TX.
	 */
	state?: string
	/**
	 * NPIs sampled, default 300.
	 */
	maxNpis?: number
	/**
	 * EM-train the FS arms (label-free), default true; `--no-train-em` uses the seeds.
	 */
	trainEm?: boolean
	/**
	 * Reproduce the pre-flip ingest (space-joined address columns with `normalizeCase` off),
	 * so that with the same data and GBT only the flip is toggled.
	 * Default off.
	 */
	legacyJoin?: boolean
	/**
	 * Optional A/B: a path to a trained dedup-gbt TS module exporting DEDUP_GBT_MODEL +
	 * DEDUP_GBT_META, scored alongside the shipped GBT at both truth levels.
	 */
	candidate?: string
	/**
	 * Write the gold-set adjudication packet of org-name-grain over-merged clusters here.
	 */
	dumpOvermerges?: string
	/**
	 * H3 resolution for the org-name-h3 truth grain, default 11 (≈25 m edge).
	 */
	h3Res?: number
	/**
	 * Geocode the sample across a worker pool ({@linkcode geocodeStream}) instead of
	 * the serial in-process path, which parallelizes the heavy per-row ONNX parse
	 * and WOF SQLite work with identical coordinates.
	 */
	parallelGeocode?: boolean
	/**
	 * Worker-pool concurrency for {@linkcode parallelGeocode}, default 2 (geocode is I/O-bound).
	 */
	geoConcurrency?: number
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
}

/**
 * The NPPES dedup benchmark (see the module doc), emitting the markdown report to stdout.
 */
export async function nppesDedupBenchmark(
	options: NPPESDedupBenchmarkOptions,
	report?: (line: string) => void
): Promise<{ markdown: string }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const STATE = stateOption(options)
	const MAX_NPIS = options.maxNpis ?? 300
	const OUT_MD = options.outMd || ""
	const TRAIN_EM = options.trainEm ?? true
	const LEGACY = options.legacyJoin ?? false
	const CANDIDATE = options.candidate || ""
	const PARALLEL_GEOCODE = options.parallelGeocode ?? false
	const GEO_CONC = options.geoConcurrency ?? 2

	const { rows, keptNpis, npiPrimary, addressFrequency } = await buildNPPESSample(
		{
			registryPath: `${SOURCES}/nppes_npi-registry_20260607.tsv`,
			otherNamesPath: `${SOURCES}/nppes_other-names_20260607.tsv`,
			state: STATE,
			maxNpis: MAX_NPIS,
		},
		report
	)

	// Without `modelCardPath`, a STAGE3 model silently mis-decodes into empty parses when `modelPath` is set.
	report?.("[C] building the geocoder + geocoding records…")

	const mapping: ColumnMapping = {
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		// `entityTruth` rides as an attribute purely for scoring, never as a discriminator
		// in matching, carrying the site-level label alongside the NPI.
		attributes: { authorizedOfficial: "auth", taxonomy: "taxonomy", entityTruth: "entityID" },
		source: "nppes",
	}

	let geo = 0
	let records: SourceRecord[]

	if (PARALLEL_GEOCODE) {
		// `address` is a single pre-joined column on this path, so `--legacy-join` is a no-op
		// and `normalizeCase` follows the worker default (on).
		if (!options.geocodeStream) {
			throw new Error("parallelGeocode requires the injected geocodeStream (see ./eval-geocoder.ts)")
		}

		const normalized = await ingestRows(rows, mapping)
		const order = new Map(normalized.map((r, i) => [r.id, i]))
		const geocoded: SourceRecord[] = []

		for await (const rec of options.geocodeStream(normalized, { mapping, concurrency: GEO_CONC })) {
			geocoded.push(rec)

			if (rec.address?.geocode) {
				geo++
			}
		}

		// Restore input order because `geocodeStream` yields in completion order
		// and downstream cluster tie-breaks must be byte-stable.
		geocoded.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
		records = geocoded
	} else {
		const geocoder = await options.createGeocoder({ normalizeCase: !LEGACY })

		const countedGeocodeForIngest: GeocodeAddress = async (raw) => {
			const g = await geocoder.geocodeAddress(raw)

			if (g?.geocode) {
				geo++
			}

			return g
		}

		records = await ingestRows(rows, mapping, {
			geocodeAddress: countedGeocodeForIngest,
			addressSeparator: LEGACY ? " " : ", ",
		})

		geocoder[Symbol.dispose]()
	}

	report?.(`    geocoded ${geo}/${rows.length} (${((100 * geo) / rows.length).toFixed(1)}%)`)

	const N = records.length

	// Every grain scores against the same record population, so the ARI expectation is fixed for the run.
	const score = (entities: readonly ResolvedEntity[], labelOf: TruthLabel): Score => scoreEntities(entities, labelOf, N)

	// Scoring the same clusters at NPI and entity level isolates how much of the apparent
	// over-merge is NPI over-segmentation rather than model error.
	const npiLabel = (rec: SourceRecord) => rec.id
	const entityLabel = (rec: SourceRecord) => rec.attributes?.["entityTruth"] ?? rec.id
	const orgNameLabel = buildOrgNameGrain(npiPrimary)

	const npiCoord = collectPrimaryCoordinates(records)
	const orgNameCoordLabel = buildOrgNameCoordGrain(npiPrimary, npiCoord)
	const geocodedNpis = [...npiPrimary.keys()].filter((n) => npiCoord.has(n)).length

	const H3_RES = options.h3Res ?? 11 // res 11 ≈ 25 m edge. res 10 ≈ 65 m (block scale)
	const orgNameH3Label = buildOrgNameH3Grain(npiPrimary, npiCoord, H3_RES)

	report?.(`[D] resolving the setting progression${TRAIN_EM ? " (EM-trained)" : ""}…`)

	// The learned scorer is default-on, so it is pinned off here.
	// Otherwise every row would silently be the GBT.
	const progression = buildSettings(addressFrequency).map((l) => {
		const res = resolveEntities(records, { learnedScorer: false, trainEM: TRAIN_EM, threshold: 0, ...l.config })

		return { ...l, res, score: score(res.entities, npiLabel) }
	})

	const bestSetting = progression.at(-1)! // the full setting stack

	// The shipped out-of-box default auto-computes an input-scoped address-frequency table.
	// on this sub-sampled corpus it is sparse and F1 collapses to ≈baseline, because IDF is a
	// corpus statistic, so the CLI passes a corpus-wide table built from the full source files.
	const defaultRes = resolveEntities(records, { learnedScorer: false, trainEM: TRAIN_EM, threshold: 0 })
	const defaultOutOfBox = score(defaultRes.entities, npiLabel)

	const THRESHOLDS = [0, 4, 8, 12, 16, 20]

	const sweep: SweepArm[] = THRESHOLDS.map((t) => {
		const res = resolveEntities(records, {
			learnedScorer: false,
			trainEM: TRAIN_EM,
			threshold: t,
			...bestSetting.config,
		})

		return { t, res, score: score(res.entities, npiLabel) }
	})

	const base = sweep[0]! // threshold 0, full setting stack
	let best = sweep[0]!

	for (const arm of sweep) {
		if (arm.score.f1 > best.score.f1) {
			best = arm
		}
	}

	report?.(
		`    progression @ threshold 0: ${progression.map((p) => `${(100 * p.score.f1).toFixed(1)}%`).join(" → ")} F1`
	)

	report?.(
		`    default F1 ${(100 * base.score.f1).toFixed(1)}% → best F1 ${(100 * best.score.f1).toFixed(1)}% @ threshold ${best.t}`
	)

	const entityCount = new Set(records.map((r) => entityLabel(r))).size
	const orgCount = new Set(records.map((r) => orgNameLabel(r))).size
	const fsNPI = bestSetting.score
	const fsEntity = score(bestSetting.res.entities, entityLabel)
	const fsOrg = score(bestSetting.res.entities, orgNameLabel)
	const gbtRes = resolveEntities(records, { addressFrequency, trainEM: TRAIN_EM }) // GBT default-on (production)
	const gbtNPI = score(gbtRes.entities, npiLabel)
	const gbtEntity = score(gbtRes.entities, entityLabel)
	const gbtOrg = score(gbtRes.entities, orgNameLabel)
	const orgCoordCount = new Set(records.map((r) => orgNameCoordLabel(r))).size
	const fsOrgCoord = score(bestSetting.res.entities, orgNameCoordLabel)
	const gbtOrgCoord = score(gbtRes.entities, orgNameCoordLabel)
	const orgH3Count = new Set(records.map((r) => orgNameH3Label(r))).size
	const gbtOrgH3 = score(gbtRes.entities, orgNameH3Label)

	const DUMP_OVERMERGES = options.dumpOvermerges || ""

	if (DUMP_OVERMERGES) {
		const clusters = await writeOvermergePacket(DUMP_OVERMERGES, {
			state: STATE,
			entities: gbtRes.entities,
			rows,
			recordCount: records.length,
			maxNpis: MAX_NPIS,
			orgNameLabel,
		})

		report?.(`    adjudication packet: ${clusters} over-merged clusters -> ${DUMP_OVERMERGES}`)
	}

	let cand: { label: string; npi: Score; entity: Score } | null = null

	if (CANDIDATE) {
		const mod = (await import(pathToFileURL(resolvePath(CANDIDATE)).href)) as {
			DEDUP_GBT_MODEL: GBT
			DEDUP_GBT_META?: { recommendedThreshold?: number; features?: number; costNegative?: number }
		}

		const t = mod.DEDUP_GBT_META?.recommendedThreshold ?? 0

		const res = resolveEntities(records, {
			addressFrequency,
			trainEM: TRAIN_EM,
			learnedScorer: mod.DEDUP_GBT_MODEL,
			threshold: t,
		})

		const cost = mod.DEDUP_GBT_META?.costNegative ?? 1

		cand = {
			label: `GBT candidate (${mod.DEDUP_GBT_META?.features ?? "?"}-feat${cost !== 1 ? `, cost ×${cost}` : ""})`,
			npi: score(res.entities, npiLabel),
			entity: score(res.entities, entityLabel),
		}

		report?.(
			`    candidate ${CANDIDATE}: NPI ${(100 * cand.npi.f1).toFixed(1)}% / entity ${(100 * cand.entity.f1).toFixed(1)}%`
		)
	}

	report?.(
		`    truth-grains — GBT NPI ${(100 * gbtNPI.f1).toFixed(1)}% → site ${(100 * gbtEntity.f1).toFixed(1)}% → org-name ${(100 * gbtOrg.f1).toFixed(1)}% → org-name-coord ${(100 * gbtOrgCoord.f1).toFixed(1)}% → org-name-h3 ${(100 * gbtOrgH3.f1).toFixed(1)}% (res ${H3_RES}); ` +
			`FS: NPI ${(100 * fsNPI.f1).toFixed(1)}% / entity ${(100 * fsEntity.f1).toFixed(1)}% / org-coord ${(100 * fsOrgCoord.f1).toFixed(1)}%`
	)

	const md = renderNPPESDedupReport({
		state: STATE,
		keptNpis: keptNpis.size,
		recordCount: N,
		geocoded: geo,
		trainEM: TRAIN_EM,
		addressFrequency,
		progression,
		defaultOutOfBox,
		sweep,
		best,
		entityCount,
		orgCount,
		orgCoordCount,
		orgH3Count,
		fsNPI,
		fsEntity,
		fsOrg,
		fsOrgCoord,
		gbtNPI,
		gbtEntity,
		gbtOrg,
		gbtOrgCoord,
		gbtOrgH3,
		candidate: cand,
		h3Res: H3_RES,
		geocodedNpis,
	})

	console.log(md)

	if (OUT_MD) {
		await writeLocalFile(md, OUT_MD)
		report?.(`\n[written] ${OUT_MD}`)
	}

	return { markdown: md }
}
