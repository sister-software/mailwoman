/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #617 NPPES dedup benchmark — the measurable proof of the record-matcher hypothesis.
 *
 *   NPPES is NPI-keyed, so the NPI is a ground-truth entity id. We build a deliberately varied
 *   multi-record set per NPI from REAL data — the registry's primary record, each alternate
 *   organization name (`nppes_other-names`, NAME drift at the same place), and the mailing address
 *   where it differs from the practice location (ADDRESS variation) — then run the matcher BLIND to
 *   the NPI (geocode → block → Fellegi-Sunter + EM → cluster) and score the recovered clusters
 *   against the NPI grouping (pairwise P/R/F1 + adjusted Rand).
 *
 *   Honest reading (per the epic): NPI-as-truth is CONSERVATIVE. A cluster that merges two NPIs is a
 *   candidate "same entity, two NPIs" surfaced for review, not an error we adjudicate; and a single
 *   NPI split across two genuinely-distant addresses is geo-first behaving correctly, counted here
 *   as a recall miss. We resolve and report; interpretation is the consumer's.
 *
 *   Sample: a tractable, variation-rich cut — providers in one state (default TX) that have ≥1
 *   alternate name, so every entity has ≥2 records and the dedup is non-trivial. Streams the 4.8 GB
 *   registry via `streamRows` (#616), so nothing loads whole.
 *
 *   The stages live in `./nppes/`: the sample, the scorer, the truth grains, the lever progression,
 *   the adjudication packet, and the report. This file is the orchestration — read it for the order
 *   of operations, the modules for what each stage does.
 *
 *   Run: `mailwoman registry scorer-eval nppes-benchmark [--state TX] [--max-npis 300]
 *   [--wof <admin.db>] [--data-root <dir>] [--no-train-em]
 *   [--out-md docs/articles/evals/matcher-dedup/<date>-nppes-dedup-benchmark.md]`
 */

import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { dataRootPath } from "@mailwoman/core/utils"
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
import { buildLevers } from "#tools/nppes/levers"
import { writeOvermergePacket } from "#tools/nppes/overmerge-packet"
import { renderNPPESDedupReport, type SweepArm } from "#tools/nppes/report"
import { buildNPPESSample } from "#tools/nppes/sample"
import { scoreEntities, type Score } from "#tools/nppes/scoring"
import {
	buildOrgNameCoordGrain,
	buildOrgNameGrain,
	buildOrgNameH3Grain,
	collectPrimaryCoordinates,
	type TruthLabel,
} from "#tools/nppes/truth-grains"

/**
 * Options for {@linkcode nppesDedupBenchmark}.
 */
export interface NPPESDedupBenchmarkOptions {
	/**
	 * The injected geocoder factory (the command wires `mailwoman/geocode-core`; see `./eval-geocoder.ts`). Model-swap
	 * overrides (`--model`/`--tokenizer`/`--model-card`) are the COMMAND's factory config, not tool options.
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * The threaded geocode surface — required when {@linkcode parallelGeocode} is set.
	 */
	geocodeStream?: EvalGeocodeStream
	/**
	 * Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * State filter. Default TX.
	 */
	state?: string
	/**
	 * NPIs sampled. Default 300.
	 */
	maxNpis?: number
	/**
	 * EM-train the FS arms (label-free). Default true; `--no-train-em` uses the seeds.
	 */
	trainEm?: boolean
	/**
	 * #694 A/B: reproduce the pre-flip ingest (space-joined address columns + normalizeCase OFF). Default off (the
	 * validated flip: comma-join + #690 all-caps normalization). Same data + GBT, only the flip toggled — so a delta here
	 * is attributable to the flip.
	 */
	legacyJoin?: boolean
	/**
	 * Optional A/B: a path to a trained dedup-gbt TS module (exports DEDUP_GBT_MODEL + DEDUP_GBT_META) to score alongside
	 * the shipped GBT at both truth levels — e.g. grade the #625 corroboration candidate.
	 */
	candidate?: string
	/**
	 * Write the #625 gold-set adjudication packet (org-name-grain over-merged clusters) here.
	 */
	dumpOvermerges?: string
	/**
	 * H3 resolution for the org-name-h3 truth grain. Default 11 (≈25 m edge).
	 */
	h3Res?: number
	/**
	 * Geocode the sample across a worker pool ({@linkcode geocodeStream}) instead of the serial in-process seam. Heavy
	 * per-row work (ONNX parse + WOF SQLite) → threading pays; measured ~1.5× at 2 workers, coordinates identical.
	 */
	parallelGeocode?: boolean
	/**
	 * Worker-pool concurrency for {@linkcode parallelGeocode}. Default 2 (geocode is I/O-bound).
	 */
	geoConcurrency?: number
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
}

/**
 * The #617 NPPES dedup benchmark — see the module doc. Emits the markdown report to stdout.
 */
export async function nppesDedupBenchmark(
	options: NPPESDedupBenchmarkOptions,
	report?: (line: string) => void
): Promise<{ markdown: string }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const STATE = (options.state || "TX").toUpperCase()
	const MAX_NPIS = options.maxNpis ?? 300
	const OUT_MD = options.outMd || ""
	const TRAIN_EM = options.trainEm ?? true
	const LEGACY = options.legacyJoin ?? false
	const CANDIDATE = options.candidate || ""
	const PARALLEL_GEOCODE = options.parallelGeocode ?? false
	const GEO_CONC = options.geoConcurrency ?? 2

	// --- Phases A + B: the variation-rich sample plus the corpus-wide address-frequency table. ---
	const { rows, keptNpis, npiPrimary, addressFrequency } = await buildNPPESSample(
		{
			registryPath: `${SOURCES}/nppes_npi-registry_20260607.tsv`,
			otherNamesPath: `${SOURCES}/nppes_other-names_20260607.tsv`,
			state: STATE,
			maxNpis: MAX_NPIS,
		},
		report
	)

	// --- Phase C: geocode + ingest (the NPI rides on record.id as the held-out label). The heavy
	// geocoder is injected (see ./eval-geocoder.ts); model-swap for a multi-version curve rides the
	// command's factory config (--model/--tokenizer/--model-card; modelCardPath is MANDATORY when
	// modelPath is set — without it a STAGE3 model silently mis-decodes into empty parses). ---
	report?.("[C] building the geocoder + geocoding records…")

	const mapping: ColumnMapping = {
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		// `entityTruth` rides as an attribute purely for scoring (NOT a discriminator → never used in
		// matching); it carries the site-level entity-level label alongside the NPI (record.id).
		attributes: { authorizedOfficial: "auth", taxonomy: "taxonomy", entityTruth: "entityID" },
		source: "nppes",
	}

	let geo = 0
	let records: SourceRecord[]

	if (PARALLEL_GEOCODE) {
		// Threaded geocode: normalize on the main thread, then hand records to a worker pool that each rebuild the
		// classifier/resolver/shards from config. `address` is a single pre-joined column here, so `--legacy-join`
		// (a separator toggle) is a no-op for this path; `normalizeCase` follows the worker default (on).
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

		// geocodeStream yields in completion order; restore input order so downstream cluster tie-breaks are byte-stable.
		geocoded.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
		records = geocoded
	} else {
		const geocoder = await options.createGeocoder({ normalizeCase: !LEGACY })

		// Count placements at the seam (parity with the retired in-script counter).
		const countedSeam: GeocodeAddress = async (raw) => {
			const g = await geocoder.seam(raw)

			if (g?.geocode) {
				geo++
			}

			return g
		}

		records = await ingestRows(rows, mapping, {
			geocodeAddress: countedSeam,
			addressSeparator: LEGACY ? " " : ", ",
		})

		geocoder[Symbol.dispose]()
	}

	report?.(`    geocoded ${geo}/${rows.length} (${((100 * geo) / rows.length).toFixed(1)}%)`)

	// --- Phase E: score recovered clusters against each truth grain (record.id = the held-out NPI). ---
	const N = records.length

	// Every grain scores against the SAME record population, so the ARI expectation is fixed for the run.
	const score = (entities: readonly ResolvedEntity[], labelOf: TruthLabel): Score => scoreEntities(entities, labelOf, N)

	// Truth labels: NPI-level (the conservative held-out NPI = record.id) and entity-level (the
	// site-level subpart-collapsed id that rides on attributes.entityTruth). Scoring the SAME clusters
	// both ways isolates how much of the apparent over-merge is NPI over-segmentation, not model error.
	const npiLabel = (rec: SourceRecord) => rec.id
	const entityLabel = (rec: SourceRecord) => rec.attributes?.["entityTruth"] ?? rec.id
	const orgNameLabel = buildOrgNameGrain(npiPrimary)

	const npiCoord = collectPrimaryCoordinates(records)
	const orgNameCoordLabel = buildOrgNameCoordGrain(npiPrimary, npiCoord)
	const geocodedNpis = [...npiPrimary.keys()].filter((n) => npiCoord.has(n)).length

	const H3_RES = options.h3Res ?? 11 // res 11 ≈ 25 m edge; res 10 ≈ 65 m (block scale)
	const orgNameH3Label = buildOrgNameH3Grain(npiPrimary, npiCoord, H3_RES)

	// --- Phase D: the comparison-model lever progression — toggle each lever ON in turn at the default
	// threshold to isolate its marginal effect, then sweep the link threshold on the best config (geocode
	// once, resolve many — config is cheap). ---
	report?.(`[D] resolving the lever progression${TRAIN_EM ? " (EM-trained)" : ""}…`)

	// learnedScorer:false throughout — this benchmark studies the FS COMPARISON-MODEL levers (#617/#625).
	// The learned scorer is now default-on, so it must be pinned off here or every row would silently be the
	// GBT; the learned scorer is measured separately (learned-scorer-clustering-eval / -crossstate-eval).
	const progression = buildLevers(addressFrequency).map((l) => {
		const res = resolveEntities(records, { learnedScorer: false, trainEM: TRAIN_EM, threshold: 0, ...l.config })

		return { ...l, res, score: score(res.entities, npiLabel) }
	})

	const bestLever = progression.at(-1)! // the full lever stack

	// The SHIPPED out-of-box default (#86): no lever config at all → resolveEntities auto-computes an
	// input-scoped address-frequency table + collapsed spatial. On this deliberately-sub-sampled corpus the
	// auto table is sparse (few repeats), so the inverse-frequency signal is near-inert and F1 collapses to
	// ≈baseline — NOT a regression, just the honest truth that IDF is a corpus statistic you can't synthesize
	// from a slice. On a FULL-dataset dedup the input IS the corpus and this default reaches the baseline; the
	// CLI passes a corpus-wide table built from the full source files so even a geocoded sub-sample benefits.
	const defaultRes = resolveEntities(records, { learnedScorer: false, trainEM: TRAIN_EM, threshold: 0 })
	const defaultOutOfBox = score(defaultRes.entities, npiLabel)

	const THRESHOLDS = [0, 4, 8, 12, 16, 20]

	const sweep: SweepArm[] = THRESHOLDS.map((t) => {
		const res = resolveEntities(records, { learnedScorer: false, trainEM: TRAIN_EM, threshold: t, ...bestLever.config })

		return { t, res, score: score(res.entities, npiLabel) }
	})

	const base = sweep[0]! // threshold 0, full lever stack
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

	// --- Phase F: NPI-level vs ENTITY-level truth. Score the SAME clusters against both yardsticks to
	// reveal how much of the apparent over-merge is NPI over-segmentation (one org / many subpart-NPIs,
	// where merging is CORRECT) rather than model error. Two production configs: the FS full lever stack
	// and the shipped default (GBT, default-on) — each fed the corpus-wide address-frequency table. ---
	const entityCount = new Set(records.map((r) => entityLabel(r))).size
	const orgCount = new Set(records.map((r) => orgNameLabel(r))).size
	const fsNPI = bestLever.score
	const fsEntity = score(bestLever.res.entities, entityLabel)
	const fsOrg = score(bestLever.res.entities, orgNameLabel)
	const gbtRes = resolveEntities(records, { addressFrequency, trainEM: TRAIN_EM }) // GBT default-on (production)
	const gbtNPI = score(gbtRes.entities, npiLabel)
	const gbtEntity = score(gbtRes.entities, entityLabel)
	const gbtOrg = score(gbtRes.entities, orgNameLabel)
	// Tier 2D: the coordinate-co-location org-name truth (tighter lower bound).
	const orgCoordCount = new Set(records.map((r) => orgNameCoordLabel(r))).size
	const fsOrgCoord = score(bestLever.res.entities, orgNameCoordLabel)
	const gbtOrgCoord = score(gbtRes.entities, orgNameCoordLabel)
	// #109: the H3-cell co-location truth — a robustness check on the haversine coord-grain.
	const orgH3Count = new Set(records.map((r) => orgNameH3Label(r))).size
	const gbtOrgH3 = score(gbtRes.entities, orgNameH3Label)

	// The adjudication packet grades the SHIPPED (GBT) clusters, because the residual over-merge is small and
	// approaching the measured ~1.6% irreducible ceiling — per-pair human adjudication (same entity? distinct
	// co-located?) is the only instrument left that can separate model error from yardstick error.
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

	// Optional candidate A/B (--candidate): score a trained GBT module at both levels, at its own
	// recommendedThreshold, alongside the shipped GBT — grades a new model (e.g. corroboration features).
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
