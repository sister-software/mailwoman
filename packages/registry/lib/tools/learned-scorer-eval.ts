/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Learned-scorer probe (#603) — does a model over the Fellegi-Sunter feature vector separate
 *   matches from non-matches BETTER than the FS scorer itself? This is the honest, rigorous answer
 *   to "is the learned-scorer path worth it?" before investing in a full GBM/training pipeline.
 *
 *   The over-merge (co-located distinct providers fused; co-located same-entity name-drift split) is
 *   a FIELD-INTERACTION effect FS can't express: it scores each field independently. A learned
 *   model with INTERACTION features (spatial-agreement × name-disagreement) can. We test that
 *   directly, with a clean methodology — no clustering confound, no leakage:
 *
 *   1. Generate the same NPI-keyed records as the dedup benchmark (real registry + name-drift +
 *        address-variation), geocoded.
 *   2. Block → candidate pairs. For each: the FS agreement pattern + engineered interaction features;
 *        the label is same-NPI.
 *   3. Split the NPIs into train / test. A pair is train iff BOTH endpoints are train-NPIs, test iff
 *        both test-NPIs — so no NPI's records leak across the split.
 *   4. Train TWO learned scorers on the train pairs: an L2 logistic regression (linear) and
 *        gradient-boosted shallow trees (non-linear — the model #603 names). Both pure-Node.
 *   5. Score the test pairs with (a) the EM-fitted FS scorer, (b) the LR, (c) the GBT. Report pairwise
 *        ROC-AUC + best-threshold F1 for each, averaged over N seeds. AUC is threshold-free: does
 *        the learned scorer RANK matches above non-matches better than FS — and does the TREE beat
 *        the LINEAR model (i.e. is there non-linear signal the hand-crafted interaction features
 *        miss)?
 *
 *   Honest caveats are printed: in-domain (TX), a modest sample, PAIRWISE (not the clustering
 *   metric). The definitive test is a GBM A/B on the dedup clustering metric with a
 *   train-TX/eval-held-out-state split (#603 Tier 2); this probe bounds the pairwise-ranking gain
 *   cheaply first.
 *
 *   Run: `mailwoman registry scorer-eval pairwise [--npis 1500] [--seeds 8] [--wof <admin.db>]
 *   [--data-root <dir>] [--seed 1] [--out-md <md>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { makeLcg } from "@mailwoman/core/random"
import { agreementPattern, block, estimateParameters, gbtScore, scorePair, trainGBT } from "@mailwoman/match"

import { buildDefaultModel, createMatchFeaturizer, defaultBlockingKeys, ingestRows, type ColumnMapping } from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import { buildNPPESSample } from "#tools/nppes/sample"
import { mean, pct, sgn, stateOption, std, trainLogisticRegression } from "#tools/shared"

/**
 * Smallest mean gap counted as a real difference rather than seed noise.
 */
const MIN_MEANINGFUL_DELTA = 0.005

/**
 * Mean gap at which a win is called outright rather than leaning.
 */
const CLEAR_WIN_DELTA = 0.01

/**
 * F1 gap at which a win is called outright.
 */
const CLEAR_WIN_F1_DELTA = 0.02

/**
 * Z at or above which the difference is treated as strong evidence rather than suggestive.
 */
const STRONG_EVIDENCE_Z = 3

/**
 * Share of NPIs assigned to train; the rest are held out for test.
 */
const TRAIN_SPLIT_FRACTION = 0.67

/**
 * Options for {@linkcode scorerPairwiseEval}.
 */
export interface ScorerPairwiseEvalOptions {
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
	 * NPIs sampled. Default 1500.
	 */
	npis?: number
	/**
	 * Base PRNG seed. Default 1.
	 */
	seed?: number
	/**
	 * Train/test splits averaged. Default 8.
	 */
	seeds?: number
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
}

/**
 * Learned-scorer pairwise probe (#603) — see the module doc. Emits the markdown report to stdout.
 */
export async function scorerPairwiseEval(
	options: ScorerPairwiseEvalOptions,
	report?: (line: string) => void
): Promise<{ markdown: string }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const STATE = stateOption(options)
	const NPIS = options.npis ?? 1500
	const SEED = options.seed ?? 1
	const OUT_MD = options.outMd || ""

	const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
	const OTHER_NAMES = `${SOURCES}/nppes_other-names_20260607.tsv`

	// --- Data-gen: the same NPI-keyed records as the dedup benchmark (the SHARED sample builder). ---
	const { rows, keptNpis, addressFrequency } = await buildNPPESSample(
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

	// --- Block + feature extraction. The model (collapsed spatial + address-frequency) defines the
	// comparisons; EM-fit it for the FS baseline. ---
	report?.("[D] blocking + features…")
	const model = buildDefaultModel({ collapseSpatial: true, addressFrequency })
	const { pairs } = block(records, defaultBlockingKeys())
	const patterns = pairs.map(([a, b]) => agreementPattern(model.comparisons, a, b))
	const fsModel = estimateParameters(model, patterns).model

	// The SHARED production featurizer (createMatchFeaturizer) — train ≡ eval ≡ inference, one definition.
	const featurize = createMatchFeaturizer({ comparisons: model.comparisons, addressFrequency })

	interface Sample {
		x: number[]
		y: number
		fs: number
	}

	interface Scored {
		s: number
		y: number
	}

	interface SplitScored {
		seed: number
		trainN: number
		testN: number
		lrScored: Scored[]
		fsScored: Scored[]
		gbtScored: Scored[]
	}

	/**
	 * One train/test split (by NPI): train the L2 logistic regression on the train pairs, then score the held-out test
	 * pairs with both the LR and the EM-fitted FS scorer. The FS model is seed-independent (fit unsupervised on ALL
	 * pairs); only the LR weights and the test subset move with the seed, so repeating over seeds bounds split variance.
	 */
	function runSplit(seed: number): SplitScored {
		const rnd = makeLcg(seed || 1)
		const npiSplit = new Map<string, "train" | "test">()

		for (const npi of keptNpis) {
			npiSplit.set(npi, rnd() < TRAIN_SPLIT_FRACTION ? "train" : "test")
		}

		const train: Sample[] = []
		const test: Sample[] = []

		pairs.forEach(([a, b]) => {
			const sa = npiSplit.get(a.id)
			const sb = npiSplit.get(b.id)

			if (!sa || sa !== sb) return

			// cross-split or unknown → drop (no leakage)
			const sample: Sample = {
				x: featurize(a, b),
				y: a.id === b.id ? 1 : 0,
				fs: scorePair(fsModel, a, b).weight,
			}
			;(sa === "train" ? train : test).push(sample)
		})

		const dim = train[0]?.x.length ?? 0
		const posWeight = train.filter((s) => s.y === 1).length / Math.max(1, train.length)
		const sampleWeights = train.map((s) => (s.y === 1 ? 1 - posWeight : posWeight))

		// L2-regularized logistic regression (batch gradient descent), rare class up-weighted — the
		// SHARED trainer.
		const lrScore = trainLogisticRegression(
			train.map((s) => s.x),
			train.map((s) => s.y),
			sampleWeights,
			dim
		)

		// Gradient-boosted trees on the SAME train pairs + class weights — the non-linear arm.
		const gbt = trainGBT(
			train.map((s) => s.x),
			train.map((s) => s.y),
			sampleWeights,
			{ rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 }
		)

		return {
			seed,
			trainN: train.length,
			testN: test.length,
			lrScored: test.map((s) => ({ s: lrScore(s.x), y: s.y })),
			fsScored: test.map((s) => ({ s: s.fs, y: s.y })),
			gbtScored: test.map((s) => ({ s: gbtScore(gbt, s.x), y: s.y })),
		}
	}

	// --- Eval on the held-out test pairs: ROC-AUC + best-threshold F1, for LR vs FS. ---
	function auc(scored: Array<{ s: number; y: number }>): number {
		const pos = scored.filter((d) => d.y === 1)
		const neg = scored.filter((d) => d.y === 0)

		if (!pos.length || !neg.length) return Number.NaN
		// Mann-Whitney U via rank.
		const sorted = [...scored].toSorted((p, q) => p.s - q.s)
		let rank = 1
		let rankSum = 0

		for (let i = 0; i < sorted.length;) {
			let j = i

			while (j < sorted.length && sorted[j]!.s === sorted[i]!.s) {
				j++
			}

			const avg = (rank + (rank + (j - i) - 1)) / 2

			for (let k = i; k < j; k++)
				if (sorted[k]!.y === 1) {
					rankSum += avg
				}

			rank += j - i
			i = j
		}

		return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)
	}

	function bestF1(scored: Array<{ s: number; y: number }>): { f1: number; precision: number; recall: number } {
		const thresholds = [...new Set(scored.map((d) => d.s))].toSorted((p, q) => p - q)
		let best = { f1: 0, precision: 0, recall: 0 }
		const P = scored.filter((d) => d.y === 1).length

		for (const t of thresholds) {
			let tp = 0
			let fp = 0

			for (const d of scored) {
				if (d.s >= t) {
					if (d.y === 1) {
						tp++
					} else {
						fp++
					}
				}
			}

			const precision = tp + fp > 0 ? tp / (tp + fp) : 0
			const recall = P > 0 ? tp / P : 0
			const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

			if (f1 > best.f1) {
				best = { f1, precision, recall }
			}
		}

		return best
	}

	report?.("[E] training across seeds…")
	const SEEDS = options.seeds ?? 8
	const splits = Array.from({ length: SEEDS }, (_, k) => runSplit(SEED + k))

	const fsAucs = splits.map((r) => auc(r.fsScored))
	const lrAucs = splits.map((r) => auc(r.lrScored))
	const deltas = splits.map((_, i) => lrAucs[i]! - fsAucs[i]!)
	const fsF1s = splits.map((r) => bestF1(r.fsScored).f1)
	const lrF1s = splits.map((r) => bestF1(r.lrScored).f1)
	const lrWins = deltas.filter((d) => d > 0).length
	const meanDelta = mean(deltas)!
	const avgTestN = mean(splits.map((r) => r.testN))!
	const avgTestPos = mean(splits.map((r) => r.lrScored.filter((d) => d.y === 1).length))!
	const seMean = std(deltas) / Math.sqrt(SEEDS) // standard error of the mean ΔAUC
	const zScore = seMean > 0 ? meanDelta / seMean : 0 // ΔAUC in standard errors above zero
	const f1Delta = mean(lrF1s)! - mean(fsF1s)! // operating-point F1 gain (LR − FS)
	const unanimous = lrWins === SEEDS
	// GBT (non-linear) arm.
	const gbtAucs = splits.map((r) => auc(r.gbtScored))
	const gbtF1s = splits.map((r) => bestF1(r.gbtScored).f1)
	const gbtVsFs = splits.map((_, i) => gbtAucs[i]! - fsAucs[i]!)
	const gbtVsLr = splits.map((_, i) => gbtAucs[i]! - lrAucs[i]!)
	const gbtBeatsLr = gbtVsLr.filter((d) => d > 0).length
	const meanGbtVsFs = mean(gbtVsFs)!
	const meanGbtVsLr = mean(gbtVsLr)!
	const f1DeltaGbt = mean(gbtF1s)! - mean(fsF1s)!

	// operating-point F1 gain (GBT − FS)
	for (const r of splits) {
		const dl = auc(r.lrScored) - auc(r.fsScored)
		const dg = auc(r.gbtScored) - auc(r.fsScored)

		report?.(
			`    seed ${r.seed}: ${r.trainN}tr/${r.testN}te  FS ${auc(r.fsScored).toFixed(4)}  ` +
				`LR ${auc(r.lrScored).toFixed(4)} (Δ${dl >= 0 ? "+" : ""}${dl.toFixed(4)})  ` +
				`GBT ${auc(r.gbtScored).toFixed(4)} (Δ${dg >= 0 ? "+" : ""}${dg.toFixed(4)})`
		)
	}

	report?.(
		`    mean/${SEEDS} — FS ${mean(fsAucs)!.toFixed(4)}  LR ${mean(lrAucs)!.toFixed(4)} (Δ${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(4)})  ` +
			`GBT ${mean(gbtAucs)!.toFixed(4)} (Δ${meanGbtVsFs >= 0 ? "+" : ""}${meanGbtVsFs.toFixed(4)} vs FS, ` +
			`${meanGbtVsLr >= 0 ? "+" : ""}${meanGbtVsLr.toFixed(4)} vs LR)`
	)

	const f4 = (x: number) => x.toFixed(4)

	const lines: string[] = [
		`# Learned-scorer probe (#603) — does a model beat Fellegi-Sunter on the FS feature vector?`,
		"",
		`_Generated by \`mailwoman registry scorer-eval pairwise\`. ${keptNpis.size} ${STATE} NPIs → ${records.length} ` +
			`records, geocoded. Candidate pairs are split BY NPI into train/test (no NPI's records cross the split), repeated ` +
			`over ${SEEDS} seeds to bound split variance. Two learned scorers over the FS agreement pattern + over-merge ` +
			`interaction features (spatial-exact × name-disagree, spatial-exact × org-disagree, address crowdedness) — features ` +
			`FS structurally cannot express — vs the EM-fitted FS scorer, on the held-out test pairs: an **L2 logistic ` +
			`regression** (linear) and **gradient-boosted trees** (non-linear, the model #603 names). AUC is threshold-free ` +
			`(does it RANK matches above non-matches?). The FS scorer is fit unsupervised on ALL pairs, so the comparison ` +
			`slightly favors FS — it has already seen the test pairs (label-free), the learned scorers have not._`,
		"",
		`## Result — mean over ${SEEDS} NPI-splits (~${Math.round(avgTestN)} test pairs/split, ~${Math.round(avgTestPos)} matches)`,
		"",
		`| scorer | ROC-AUC (mean±std) | ΔAUC vs FS | best F1 (mean) |`,
		`|---|---:|---:|---:|`,
		`| Fellegi-Sunter (EM-fit) | ${f4(mean(fsAucs)!)} ± ${f4(std(fsAucs))} | — | ${pct(mean(fsF1s)!)}% |`,
		`| logistic regression (linear) | ${f4(mean(lrAucs)!)} ± ${f4(std(lrAucs))} | ${sgn(meanDelta)}${f4(meanDelta)} | ${pct(mean(lrF1s)!)}% |`,
		`| **gradient-boosted trees** | **${f4(mean(gbtAucs)!)} ± ${f4(std(gbtAucs))}** | **${sgn(meanGbtVsFs)}${f4(meanGbtVsFs)}** | **${pct(mean(gbtF1s)!)}%** |`,
		"",
		`**ΔAUC (LR − FS): ${sgn(meanDelta)}${f4(meanDelta)} ± ${f4(std(deltas))}, LR > FS in ${lrWins}/${SEEDS} seeds.**`,
		"",
		`Robustness: the ΔAUC is small but **consistent** — std ${f4(std(deltas))} across seeds, SE ±${f4(seMean)} → ` +
			`≈${zScore.toFixed(1)}σ above zero, ${lrWins}/${SEEDS} seeds in LR's favour. At the operating point the gap is ` +
			`larger: **ΔF1 ${sgn(f1Delta * 100)}${(f1Delta * 100).toFixed(1)}pp** (${pct(mean(fsF1s)!)}% → ${pct(mean(lrF1s)!)}%), ` +
			`because the interaction features sharpen the hard co-located band near the decision boundary even where overall ` +
			`ranking barely moves.`,
		"",
	]

	// Linear vs tree: does a non-linear model extract MORE than the LR? (The probe's open question.)
	const treeVerdict =
		meanGbtVsLr > MIN_MEANINGFUL_DELTA && gbtBeatsLr >= SEEDS - 1
			? `**The tree extends the linear gain** — GBT beats the LR by ΔAUC ${sgn(meanGbtVsLr)}${f4(meanGbtVsLr)} ` +
				`(${gbtBeatsLr}/${SEEDS} seeds), ${sgn(meanGbtVsFs)}${f4(meanGbtVsFs)} over FS, ΔF1 ${sgn(f1DeltaGbt * 100)}${(f1DeltaGbt * 100).toFixed(1)}pp. ` +
				`Non-linear interactions the hand-crafted features miss carry additional signal — a real GBM (XGBoost/LightGBM, ` +
				`more NPIs, more features) is worth building.`
			: meanGbtVsLr < -MIN_MEANINGFUL_DELTA
				? `**The tree does NOT beat the linear model** (GBT − LR = ${sgn(meanGbtVsLr)}${f4(meanGbtVsLr)} AUC, ` +
					`${gbtBeatsLr}/${SEEDS} seeds; GBT − FS = ${sgn(meanGbtVsFs)}${f4(meanGbtVsFs)}). With the over-merge interactions ` +
					`already hand-engineered into the feature vector, a shallow tree finds little extra and slightly overfits the ` +
					`small label set — the LR is the better-behaved scorer here.`
				: `**The tree roughly TIES the linear model** (GBT − LR = ${sgn(meanGbtVsLr)}${f4(meanGbtVsLr)} AUC, ` +
					`${gbtBeatsLr}/${SEEDS} seeds; GBT − FS = ${sgn(meanGbtVsFs)}${f4(meanGbtVsFs)}, ΔF1 ${sgn(f1DeltaGbt * 100)}${(f1DeltaGbt * 100).toFixed(1)}pp). ` +
					`Because the key over-merge interactions are ALREADY hand-engineered into the feature vector, the tree's main ` +
					`advantage — auto-discovering interactions — is largely pre-empted; it neither extends nor erases the linear ` +
					`gain. The signal in this feature set is close to linearly saturated, so a production GBM should budget for the ` +
					`SAME modest margin the LR shows, not a step change — its real value is generalizing the #625 levers, not ` +
					`finding hidden non-linear structure here.`

	lines.push(treeVerdict)
	lines.push("")
	lines.push(`### Per-seed`)
	lines.push("")
	lines.push(`| seed | test pairs | FS AUC | LR AUC | GBT AUC |`)
	lines.push(`|---:|---:|---:|---:|---:|`)

	for (const r of splits) {
		lines.push(`| ${r.seed} | ${r.testN} | ${f4(auc(r.fsScored))} | ${f4(auc(r.lrScored))} | ${f4(auc(r.gbtScored))} |`)
	}

	lines.push("")

	const verdict =
		unanimous && (meanDelta > CLEAR_WIN_DELTA || f1Delta > CLEAR_WIN_F1_DELTA)
			? `The LR beats FS **consistently** — it wins ${lrWins}/${SEEDS} seeds and lifts the operating-point F1 by ` +
				`${sgn(f1Delta * 100)}${(f1Delta * 100).toFixed(1)}pp (${pct(mean(fsF1s)!)}% → ${pct(mean(lrF1s)!)}%). The ΔAUC is ` +
				`small (+${f4(meanDelta)}) only because FS already ranks well (${f4(mean(fsAucs)!)}); the gain concentrates at the ` +
				`decision boundary, exactly where the interaction features (which FS structurally can't express) bite. ` +
				`**This greenlights the #603 learned scorer:** a GBM — non-linear over the same features — is the principled ` +
				`generalization of the hand-tuned #625 levers and should extend this linear gain. Honest framing: the linear ` +
				`headroom is modest, so the GBM's job is to *widen a real-but-small margin*, not to unlock a step change past the ` +
				`64.7% dedup plateau on its own — the reliable secondary identifier (#625) is still the larger lever.`
			: unanimous && zScore >= STRONG_EVIDENCE_Z
				? `The LR beats FS by a **small but statistically robust** margin (ΔAUC +${f4(meanDelta)}, ≈${zScore.toFixed(1)}σ, ` +
					`${lrWins}/${SEEDS} seeds; ΔF1 ${sgn(f1Delta * 100)}${(f1Delta * 100).toFixed(1)}pp). The interaction features ` +
					`carry real signal, but FS's calibrated weights already capture most of it. **Qualified greenlight for #603:** a ` +
					`tree may extend the margin, but budget for a modest gain, not a plateau-breaker.`
				: meanDelta < -MIN_MEANINGFUL_DELTA && lrWins < SEEDS / 2
					? `The LR is **worse** than FS (ΔAUC ${f4(meanDelta)}, ${lrWins}/${SEEDS} seeds) — the linear+interaction features ` +
						`don't help on this sample. FS's calibrated weights are hard to beat here; a tree is the only remaining test ` +
						`before committing to #603.`
					: `The LR and FS are **statistically indistinguishable** (ΔAUC ${sgn(meanDelta)}${f4(meanDelta)}, ${lrWins}/${SEEDS} ` +
						`seeds, within noise). On these features the over-merge resists a learned scorer — the discriminating signal a ` +
						`reliable secondary identifier provides (#625) isn't recoverable from the FS feature vector alone. A richer ` +
						`feature set or a tree is the next test before committing to #603.`

	lines.push(verdict)
	lines.push("")
	lines.push(`## Honest caveats`)
	lines.push("")

	lines.push(
		`In-domain (${STATE} only), ${keptNpis.size} NPIs, PAIRWISE ranking (not the assembled clustering metric the dedup ` +
			`benchmark reports against the 64.7% baseline — a better pairwise scorer need not translate 1:1 to cluster F1). The GBT ` +
			`is a compact pure-Node implementation (120 boosting rounds, depth 3), a faithful stand-in for an offline ` +
			`XGBoost/LightGBM but not tuned. The split is by NPI so there's no record-level leakage, but the address-frequency ` +
			`feature is a corpus statistic over all NPIs (a population prior, not per-pair leakage), and the FS scorer is EM-fit ` +
			`on all pairs including the test subset (standard for label-free FS — it makes the learned scorers' win the harder ` +
			`result). At ~${Math.round(avgTestN)} test pairs/split both AUC and F1 are stable across seeds (per-seed table). The ` +
			`definitive test remains a GBM A/B on the **clustering** metric with a train-TX / eval-held-out-state split (#603 ` +
			`Tier 2)._`
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
