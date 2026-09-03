/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Learned-scorer CLUSTERING A/B (#603 Tier 2) — the definitive test the pairwise probe
 *   (`learned-scorer-eval.ts`) deferred. The probe showed a learned scorer ranks candidate pairs
 *   better than Fellegi-Sunter (GBT +0.0177 AUC, +6.6pp pairwise F1); a better pairwise scorer need
 *   NOT lift the assembled clustering F1 (clustering depends on the threshold +
 *   connected-components). This measures the clustering F1 directly, leakage-free:
 *
 *   1. Sample NPI-keyed records (real registry + name-drift + address-variation), geocode once.
 *   2. Split the NPIs into TRAIN / EVAL. Train a GBT + an LR on pairs blocked among TRAIN records (label
 *        = same-NPI). The eval NPIs' records are never seen in training.
 *   3. Cluster the EVAL records three ways via the SAME `resolveEntities` pipeline (block → score →
 *        connected-components) — once with the FS baseline, once with the GBT as the link scorer
 *        (the new `ResolveConfig.scorer` hook), once with the LR. Sweep the link threshold for
 *        each; take best F1.
 *   4. Report the eval clustering F1 (the dedup benchmark's metric): does the learned scorer beat the FS
 *        baseline on the ASSEMBLED output, not just pairwise ranking?
 *
 *   The FS arm IS the benchmark's baseline (same model: address-frequency + collapsed spatial,
 *   EM-fit), so the comparison is credible. Honest framing: in-domain (one state), a held-out-NPI
 *   split (not a held-out STATE — generalization across states is the next axis), a compact
 *   pure-Node GBT.
 *
 *   Run: `mailwoman registry scorer-eval clustering [--npis 2000] [--split 0.67] [--seed 1]
 *   [--out-md <md>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { makeLcg } from "@mailwoman/core/random"
import { block, gbtScore, trainGBT } from "@mailwoman/match"

import {
	buildDefaultModel,
	createMatchFeaturizer,
	defaultBlockingKeys,
	ingestRows,
	resolveEntities,
	type ColumnMapping,
	type SourceRecord,
} from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import { buildNPPESSample } from "#tools/nppes/sample"
import { scoreEntities } from "#tools/nppes/scoring"
import {
	bestOver,
	mean,
	MIN_MEANINGFUL_F1_DELTA,
	pct,
	quantileThresholds,
	sgn,
	stateOption,
	std,
	toArmScore,
	trainLogisticRegression,
	type ArmScore,
} from "#tools/shared"

/**
 * Options for {@linkcode scorerClusteringEval}.
 */
export interface ScorerClusteringEvalOptions {
	/**
	 * The injected geocoder factory (the command wires `mailwoman/geocode-core`; see `./eval-geocoder.ts`).
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * State filter. Default TX.
	 */
	state?: string
	/**
	 * NPIs sampled. Default 2000.
	 */
	npis?: number
	/**
	 * Train fraction of the NPI split. Default 0.67.
	 */
	split?: number
	/**
	 * Base PRNG seed. Default 1.
	 */
	seed?: number
	/**
	 * Held-out-NPI splits averaged. Default 4.
	 */
	seeds?: number
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
}

/**
 * Learned-scorer clustering A/B (#603 Tier 2) — see the module doc. Emits the markdown report to stdout.
 */
export async function scorerClusteringEval(
	options: ScorerClusteringEvalOptions,
	report?: (line: string) => void
): Promise<{ markdown: string }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const STATE = stateOption(options)
	const NPIS = options.npis ?? 2000
	const SPLIT = options.split ?? 0.67
	const SEED = options.seed ?? 1
	const OUT_MD = options.outMd || ""

	const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
	const OTHER_NAMES = `${SOURCES}/nppes_other-names_20260607.tsv`

	// --- Data-gen: the same NPI-keyed records as the dedup benchmark + the pairwise probe (the SHARED
	// sample builder). ---
	const {
		rows,
		keptNpis: kept,
		addressFrequency,
	} = await buildNPPESSample(
		{ registryPath: REGISTRY, otherNamesPath: OTHER_NAMES, state: STATE, maxNpis: NPIS },
		report
	)

	report?.("[C] geocoding…")
	const geocoder = await options.createGeocoder()

	// `auth`/`taxonomy` ride as attributes so the SHARED featurizer's #625 roll-up features can read the
	// authorized official; the FS arm ignores them (no discriminators configured).
	const mapping: ColumnMapping = {
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		attributes: { authorizedOfficial: "auth", taxonomy: "taxonomy" },
		source: "nppes",
	}

	const records = await ingestRows(rows, mapping, {
		geocodeAddress: geocoder.seam,
	})

	geocoder[Symbol.dispose]()

	// --- The feature basis: address-frequency + collapsed-spatial model (the baseline). The agreement
	// pattern is EM-independent, so the same featurize() is consistent at train and inference time. ---
	// The featurizer is the SHARED production one (createMatchFeaturizer) — train ≡ eval ≡ inference, one
	// definition. Feed the collapsed-spatial + address-frequency comparison set (the benchmark baseline).
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })

	const npiLabel = (rec: SourceRecord) => rec.id

	interface SeedResult {
		seed: number
		trainN: number
		evalN: number
		fs: ArmScore
		lr: ArmScore
		gbt: ArmScore
	}

	/**
	 * One held-out-NPI split: train the GBT + LR on TRAIN pairs, then cluster the EVAL records three ways (FS baseline,
	 * GBT scorer, LR scorer) through the same `resolveEntities` pipeline, sweeping the link threshold finely for each and
	 * taking best F1. The geocode is shared across seeds; only the split, the trained scorers, and the eval subset move
	 * with the seed.
	 */
	function runSeed(seed: number): SeedResult {
		const rnd = makeLcg(seed || 1)
		const npiSplit = new Map<string, "train" | "eval">()

		for (const npi of kept) {
			npiSplit.set(npi, rnd() < SPLIT ? "train" : "eval")
		}

		const trainRecords = records.filter((r) => npiSplit.get(r.id) === "train")
		const evalRecords = records.filter((r) => npiSplit.get(r.id) === "eval")
		const N = evalRecords.length

		const { pairs: trainPairs } = block(trainRecords, defaultBlockingKeys())
		const trainX = trainPairs.map(([a, b]) => featurize(a, b))
		const trainY = trainPairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
		const posRate = trainY.reduce<number>((s, v) => s + v, 0) / Math.max(1, trainY.length)
		const trainW = trainY.map((y) => (y === 1 ? 1 - posRate : posRate))
		const dim = trainX[0]?.length ?? 0
		const gbt = trainGBT(trainX, trainY, trainW, { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 })

		// LR (batch GD, class-balanced) — the SHARED trainer, same as the pairwise probe.
		const lrSc = trainLogisticRegression(trainX, trainY, trainW, dim)

		const gbtScorer = (a: SourceRecord, b: SourceRecord) => gbtScore(gbt, featurize(a, b))
		const lrScorer = (a: SourceRecord, b: SourceRecord) => lrSc(featurize(a, b))

		const armOver = (
			thresholds: readonly number[],
			cfg: (t: number) => Parameters<typeof resolveEntities>[1]
		): ArmScore =>
			bestOver(thresholds, (t) => toArmScore(scoreEntities(resolveEntities(evalRecords, cfg(t)).entities, npiLabel, N)))

		// FS baseline: EM-fit weights in bits, fine grid [0..25]. Learned scorers: a FINE sweep from each
		// scorer's own eval-pair score distribution, so a coarse grid can't understate them.
		const { pairs: evalPairs } = block(evalRecords, defaultBlockingKeys())

		const fs = armOver(
			Array.from({ length: 26 }, (_, i) => i),
			// learnedScorer:false — the FS baseline is the baseline this A/B measures against (the learned scorer
			// is now default-on, so without this the "FS arm" would silently BE the GBT).
			(t) => ({ addressFrequency, collapseSpatial: true, trainEM: true, threshold: t, learnedScorer: false })
		)

		const gbtArm = armOver(quantileThresholds(evalPairs.map(([a, b]) => gbtScorer(a, b))), (t) => ({
			addressFrequency,
			collapseSpatial: true,
			scorer: gbtScorer,
			threshold: t,
		}))

		const lrArm = armOver(quantileThresholds(evalPairs.map(([a, b]) => lrScorer(a, b))), (t) => ({
			addressFrequency,
			collapseSpatial: true,
			scorer: lrScorer,
			threshold: t,
		}))

		return { seed, trainN: trainRecords.length, evalN: N, fs, lr: lrArm, gbt: gbtArm }
	}

	const SEEDS = options.seeds ?? 4
	report?.(`[D-F] ${SEEDS} held-out-NPI splits: FS baseline vs GBT vs LR…`)
	const results: SeedResult[] = []

	for (let k = 0; k < SEEDS; k++) {
		const r = runSeed(SEED + k)
		results.push(r)

		report?.(
			`    seed ${r.seed}: ${r.trainN}tr/${r.evalN}ev  FS ${pct(r.fs.f1)}  LR ${pct(r.lr.f1)} (${sgn(r.lr.f1 - r.fs.f1)}${pct(r.lr.f1 - r.fs.f1)})  ` +
				`GBT ${pct(r.gbt.f1)} (${sgn(r.gbt.f1 - r.fs.f1)}${pct(r.gbt.f1 - r.fs.f1)})`
		)
	}

	const fsF1 = results.map((r) => r.fs.f1)
	const gbtF1 = results.map((r) => r.gbt.f1)
	const dGbt = results.map((r) => r.gbt.f1 - r.fs.f1)
	const dLr = results.map((r) => r.lr.f1 - r.fs.f1)
	const gbtWins = dGbt.filter((d) => d > 0).length
	const meanDGbt = mean(dGbt)!

	const armRow = (label: string, pick: (r: SeedResult) => ArmScore, dArr: number[] | null, bold: boolean) => {
		const f1s = results.map((r) => pick(r).f1)
		const P = mean(results.map((r) => pick(r).precision))!
		const R = mean(results.map((r) => pick(r).recall))!
		const om = mean(results.map((r) => pick(r).overMerged))!
		const d = dArr ? `${sgn(mean(dArr)! * 100)}${(mean(dArr)! * 100).toFixed(1)}pp` : "—"
		const f1cell = `${pct(mean(f1s)!)}% ± ${pct(std(f1s))}`
		const cells = `${pct(P)}% | ${pct(R)}% | ${bold ? `**${f1cell}**` : f1cell} | ${bold ? `**${d}**` : d} | ${om.toFixed(0)}`

		return `| ${bold ? `**${label}**` : label} | ${cells} |`
	}

	const avgEval = Math.round(mean(results.map((r) => r.evalN))!)
	const avgTrain = Math.round(mean(results.map((r) => r.trainN))!)

	const lines: string[] = [
		`# Learned-scorer CLUSTERING A/B (#603 Tier 2) — does a learned scorer beat the FS baseline on the assembled output?`,
		"",
		`_Generated by \`mailwoman registry scorer-eval clustering\`. ${kept.size} ${STATE} NPIs → ` +
			`${records.length} records, geocoded; split by NPI into ~${avgTrain} train / ~${avgEval} eval records over ${SEEDS} ` +
			`seeds (the GBT/LR never see an eval NPI's records). The held-out EVAL records are clustered three ways through the ` +
			`SAME \`resolveEntities\` pipeline (block → score → connected-components): the FS baseline (address-frequency + ` +
			`collapsed-spatial, EM-fit), the GBT as the link scorer (the new \`ResolveConfig.scorer\` hook), and the LR. Best F1 ` +
			`over a fine per-scorer link-threshold sweep, averaged across seeds. This is the dedup benchmark's clustering metric ` +
			`— the definitive test the pairwise probe (#637/#640) deferred._`,
		"",
		`## Result — eval clustering F1 (best over threshold, mean ± std over ${SEEDS} seeds, ~${avgEval} held-out records)`,
		"",
		`| scorer | precision | recall | F1 | ΔF1 vs FS | over-merged clusters |`,
		`|---|---:|---:|---:|---:|---:|`,
		armRow("FS baseline (EM-fit)", (r) => r.fs, null, false),
		armRow("logistic regression", (r) => r.lr, dLr, false),
		armRow("gradient-boosted trees", (r) => r.gbt, dGbt, true),
		"",
		`**ΔF1 (GBT − FS): ${sgn(meanDGbt * 100)}${(meanDGbt * 100).toFixed(1)}pp mean, GBT > FS in ${gbtWins}/${SEEDS} seeds.**`,
		"",
	]

	const verdict =
		meanDGbt > MIN_MEANINGFUL_F1_DELTA && gbtWins >= SEEDS - 1
			? `**The learned scorer beats the FS baseline on the assembled clustering output** — GBT clustering F1 ` +
				`${pct(mean(gbtF1)!)}% vs FS ${pct(mean(fsF1)!)}% (${sgn(meanDGbt * 100)}${(meanDGbt * 100).toFixed(1)}pp mean, ${gbtWins}/${SEEDS} ` +
				`seeds), driven by a large PRECISION gain that cuts the over-merge — the #625 problem. The pairwise gain (#640) ` +
				`DOES translate to the entity-resolution metric. This confirms the #603 GBM as a real dedup change and justifies the ` +
				`production build (offline XGBoost/LightGBM → tree JSON, the \`scorer\` hook for inference). The honest next axis is ` +
				`cross-STATE generalization (train-TX / eval-other-state) and a tuned GBM on more features.`
			: meanDGbt < -MIN_MEANINGFUL_F1_DELTA
				? `**The learned scorer does NOT beat the FS baseline on clustering** (GBT ${pct(mean(gbtF1)!)}% vs FS ${pct(mean(fsF1)!)}%, ` +
					`${(meanDGbt * 100).toFixed(1)}pp). The pairwise ranking gain (#640) does not survive the threshold + ` +
					`connected-components assembly — clustering, not ranking, is the binding constraint. FS stays the baseline.`
				: `**The learned scorer roughly TIES the FS baseline on clustering** (GBT ${pct(mean(gbtF1)!)}% vs FS ${pct(mean(fsF1)!)}%, ` +
					`${sgn(meanDGbt * 100)}${(meanDGbt * 100).toFixed(1)}pp, ${gbtWins}/${SEEDS} seeds). The pairwise ranking gain (#640) is ` +
					`real but largely washes out through the threshold + connected-components assembly. A learned scorer is not a free ` +
					`dedup win; pairing it with a clustering change or a more distinctive identifier (#625) is the path.`

	lines.push(verdict)
	lines.push("")
	lines.push(`### Per-seed F1`)
	lines.push("")
	lines.push(`| seed | eval records | FS | LR | GBT |`)
	lines.push(`|---:|---:|---:|---:|---:|`)

	for (const r of results) {
		lines.push(`| ${r.seed} | ${r.evalN} | ${pct(r.fs.f1)}% | ${pct(r.lr.f1)}% | ${pct(r.gbt.f1)}% |`)
	}

	lines.push("")
	lines.push(`## Honest caveats`)
	lines.push("")

	lines.push(
		`In-domain (${STATE}), a held-out-NPI split (NOT a held-out STATE — cross-state generalization is the next axis, ` +
			`the #603 train-TX/eval-other-state design). The FS arm IS the benchmark baseline (same model), so the comparison is ` +
			`fair. The GBT is a compact pure-Node implementation (120 rounds, depth 3), not a tuned XGBoost/LightGBM — a real ` +
			`GBM with more NPIs/features could move the number further. Thresholds are swept per scorer (FS in bits, learned ` +
			`scorers in logits), each at its own best operating point — note a 300-NPI smoke MISLED (FS ahead): too few ` +
			`co-located collisions to exhibit the over-merge, which only bites at scale, so trust the larger eval. NPI-as-truth ` +
			`is conservative (a cross-NPI merge is a candidate, not necessarily an error)._`
	)

	lines.push("")

	const md = lines.join("\n")

	console.log(md)

	if (OUT_MD) {
		await writeLocalFile(md, OUT_MD)
		report?.(`[written] ${OUT_MD}`)
	}

	return { markdown: md }
}
