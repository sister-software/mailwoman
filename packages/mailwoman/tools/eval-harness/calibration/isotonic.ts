/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fits an isotonic calibrator for span confidence and measures calibration error on a held-out split.
 *
 *   The input is the `(confidence, correct)` span records `collect-span-confidences.run.ts` writes. The fit reads a
 *   seeded 80% of the records and every figure is measured on the other 20%. The output is the lookup table the
 *   opt-in decoder calibrator in `packages/core/lib/decoder/calibration.ts` loads, and a markdown report.
 *
 *   The model is overconfident in some confidence bands and underconfident in others, so a sigmoid (Platt) fit does
 *   not suit it, and the fit is Pool-Adjacent-Violators. OpenAddresses rows get their own ECE, because the corpus
 *   rows are in-domain and their confidence runs high.
 *
 *   The held-out split is a permutation of the records. The committed tables were split by NumPy's
 *   `default_rng(seed).permutation(n)`, recorded in `data/eval/calibration/permutations.json` for their seed and
 *   size, so a refit of a committed table reproduces it. A seed and size the file does not hold is split by
 *   {@linkcode seededPermutation}, a different generator: that is a new fit, with its own report.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pyFixed } from "@mailwoman/core/numeric"
import { repoRootPath } from "@mailwoman/core/paths"
import { mulberry32, shuffleWith } from "@mailwoman/core/random"
import { asPythonFloat, type PythonFloat } from "@mailwoman/core/strings/python-json"

import { numpyInterp, numpyLinspace, numpyMean, stableArgsort } from "./numpy.ts"

/**
 * The report omits a subgroup with fewer held-out spans than this, because its ECE is mostly bin noise.
 */
export const MIN_SUBGROUP_SPANS = 100

/**
 * The calibrated-confidence accept thresholds the abstention curve reports.
 */
export const ABSTENTION_THRESHOLDS = [0.5, 0.8, 0.9, 0.95, 0.97] as const

/**
 * The fewest samples a bin holds for the bin-filtered maximum calibration error to read it.
 *
 * A bin of one or two samples would otherwise set the maximum.
 */
export const ROBUST_MCE_MIN_SAMPLES = 20

/**
 * The share of the records the held-out split takes: one in five.
 */
const EVAL_DIVISOR = 5

/**
 * The recorded NumPy permutations.
 */
export const PERMUTATIONS_PATH = repoRootPath("data", "eval", "calibration", "permutations.json")

/**
 * One span record of the confidences file.
 */
export interface SpanConfidence {
	conf: number
	correct: boolean
	source: string
	tag: string
	country: string
}

/**
 * The permutation NumPy's `default_rng(seed).permutation(n)` drew, when the recorded file holds it.
 */
export async function recordedPermutation(seed: number, n: number): Promise<number[] | null> {
	const document = await readLocalJSONFile<{ permutations: Record<string, number[]> }>(PERMUTATIONS_PATH)

	return document.permutations[`${seed}:${n}`] ?? null
}

/**
 * A permutation of `0..n-1` for a seed and size the recorded file does not hold:
 * a Fisher–Yates shuffle driven by `mulberry32(seed)`.
 * It is not NumPy's, so a fit split by it is a new fit.
 */
export function seededPermutation(seed: number, n: number): number[] {
	const order = Array.from({ length: n }, (_, i) => i)

	shuffleWith(order, mulberry32(seed))

	return order
}

/**
 * The weighted non-decreasing least-squares fit of `y` by Pool-Adjacent-Violators.
 *
 * Each block holds a weighted sum, a weight and a count, and a new point merges leftward
 * until the block means are non-decreasing.
 */
export function pava(y: readonly number[], w: readonly number[]): number[] {
	const sums: number[] = []
	const weights: number[] = []
	const counts: number[] = []

	for (const [i, yi] of y.entries()) {
		sums.push(yi * w[i]!)
		weights.push(w[i]!)
		counts.push(1)

		while (sums.length >= 2 && sums.at(-2)! / weights.at(-2)! > sums.at(-1)! / weights.at(-1)!) {
			const s = sums.pop()! + sums.at(-1)!
			const wt = weights.pop()! + weights.at(-1)!
			const c = counts.pop()! + counts.at(-1)!

			sums[sums.length - 1] = s
			weights[weights.length - 1] = wt
			counts[counts.length - 1] = c
		}
	}

	const out: number[] = []

	for (const [b, s] of sums.entries()) {
		for (let k = 0; k < counts[b]!; k++) {
			out.push(s / weights[b]!)
		}
	}

	return out
}

/**
 * The sorted confidences and their isotonic fitted values.
 */
export function fitIsotonic(conf: readonly number[], correct: readonly number[]): { xs: number[]; g: number[] } {
	const order = stableArgsort(conf)
	const xs = order.map((i) => conf[i]!)
	const ys = order.map((i) => correct[i]!)

	return {
		xs,
		g: pava(
			ys,
			ys.map(() => 1)
		),
	}
}

/**
 * One reliability bin.
 */
export interface ReliabilityBin {
	lo: PythonFloat
	hi: PythonFloat
	n: number
	conf: PythonFloat | null
	acc: PythonFloat | null
}

/**
 * The expected and maximum calibration error over equal-width bins, with the per-bin rows.
 */
export function ece(
	conf: readonly number[],
	correct: readonly number[],
	bins: number
): { e: number; mce: number; rows: ReliabilityBin[] } {
	const edges = numpyLinspace(0, 1, bins + 1)
	const n = conf.length
	const rows: ReliabilityBin[] = []
	let e = 0
	let mce = 0

	for (let b = 0; b < bins; b++) {
		const lo = edges[b]!
		const hi = edges[b + 1]!
		const inBin = (c: number) => c >= lo && (b < bins - 1 ? c < hi : c <= hi)
		const selectedConf: number[] = []
		const selectedCorrect: number[] = []

		for (const [i, c] of conf.entries()) {
			if (inBin(c)) {
				selectedConf.push(c)
				selectedCorrect.push(correct[i]!)
			}
		}

		const nb = selectedConf.length

		if (!nb) {
			rows.push({ lo: asPythonFloat(lo), hi: asPythonFloat(hi), n: 0, conf: null, acc: null })

			continue
		}

		const cb = numpyMean(selectedConf)
		const ab = numpyMean(selectedCorrect)
		const gap = Math.abs(cb - ab)

		e += (nb / n) * gap
		mce = Math.max(mce, gap)
		rows.push({ lo: asPythonFloat(lo), hi: asPythonFloat(hi), n: nb, conf: asPythonFloat(cb), acc: asPythonFloat(ab) })
	}

	return { e, mce, rows }
}

/**
 * The maximum calibration error over bins holding at least {@linkcode ROBUST_MCE_MIN_SAMPLES} samples.
 */
export function robustMCE(rows: readonly ReliabilityBin[]): number {
	const gaps = rows
		.filter((r) => r.n >= ROBUST_MCE_MIN_SAMPLES && r.conf)
		.map((r) => Math.abs(r.conf!.value - r.acc!.value))

	return gaps.length ? Math.max(...gaps) : 0
}

/**
 * The Brier score: the mean squared gap between confidence and correctness.
 */
export function brier(conf: readonly number[], correct: readonly number[]): number {
	return numpyMean(conf.map((c, i) => (c - correct[i]!) ** 2))
}

/**
 * The values at `indexes`, in their order: NumPy's fancy indexing.
 */
function atIndexes<T>(values: readonly T[], indexes: readonly number[]): T[] {
	return indexes.map((i) => values[i]!)
}

function subgroupECE(
	keys: readonly string[],
	conf: readonly number[],
	cal: readonly number[],
	correct: readonly number[],
	eceBins: number
) {
	const out: Record<string, { n: number; acc: PythonFloat; ece_raw: PythonFloat; ece_cal: PythonFloat }> = {}

	for (const key of [...new Set(keys)].toSorted()) {
		const members = keys.flatMap((k, i) => (k === key ? [i] : []))

		if (members.length < MIN_SUBGROUP_SPANS) continue

		out[key] = {
			n: members.length,
			acc: asPythonFloat(numpyMean(atIndexes(correct, members))),
			ece_raw: asPythonFloat(ece(atIndexes(conf, members), atIndexes(correct, members), eceBins).e),
			ece_cal: asPythonFloat(ece(atIndexes(cal, members), atIndexes(correct, members), eceBins).e),
		}
	}

	return out
}

function abstentionCurve(cal: readonly number[], correct: readonly number[]) {
	return ABSTENTION_THRESHOLDS.map((threshold) => {
		const accepted = cal.flatMap((c, i) => (c >= threshold ? [i] : []))
		const coverage = accepted.length / cal.length

		return {
			threshold: asPythonFloat(threshold),
			coverage: asPythonFloat(coverage),
			precision: asPythonFloat(accepted.length ? numpyMean(atIndexes(correct, accepted)) : 0),
			reviewed: asPythonFloat(1 - coverage),
		}
	})
}

/**
 * The calibrated value at the center of each equal-width bin.
 */
export function lookupTable(xs: readonly number[], g: readonly number[], bins: number) {
	const edges = numpyLinspace(0, 1, bins + 1)

	return Array.from({ length: bins }, (_, i) => {
		const center = (edges[i]! + edges[i + 1]!) / 2

		return {
			lo: asPythonFloat(edges[i]!),
			hi: asPythonFloat(edges[i + 1]!),
			center: asPythonFloat(center),
			calibrated: asPythonFloat(numpyInterp(center, xs, g)),
		}
	})
}

/**
 * One isotonic fit and every figure measured from it, which the table and the report both read.
 */
export type IsotonicFit = ReturnType<typeof fitAndMeasure>

/**
 * Fits on the records the permutation leaves past its first fifth and measures every figure on that fifth.
 */
export function fitAndMeasure(
	records: readonly SpanConfidence[],
	options: { bins: number; eceBins: number; permutation: readonly number[] }
) {
	const { bins, eceBins, permutation } = options

	if (permutation.length !== records.length) {
		throw new Error(`the permutation orders ${permutation.length} records, the confidences hold ${records.length}`)
	}

	const conf = records.map((r) => r.conf)
	const correct = records.map((r) => (r.correct ? 1 : 0))
	const nEval = Math.floor(records.length / EVAL_DIVISOR)
	const evalIndex = permutation.slice(0, nEval)
	const fitIndex = permutation.slice(nEval)
	const { xs, g } = fitIsotonic(atIndexes(conf, fitIndex), atIndexes(correct, fitIndex))
	const evConf = atIndexes(conf, evalIndex)
	const evCorrect = atIndexes(correct, evalIndex)

	const evSource = atIndexes(
		records.map((r) => r.source),
		evalIndex
	)

	const evCal = evConf.map((c) => numpyInterp(c, xs, g))
	const raw = ece(evConf, evCorrect, eceBins)
	const cal = ece(evCal, evCorrect, eceBins)

	const bySource = (source: string) => {
		const members = evSource.flatMap((s, i) => (s === source ? [i] : []))

		return {
			raw: ece(atIndexes(evConf, members), atIndexes(evCorrect, members), eceBins).e,
			cal: ece(atIndexes(evCal, members), atIndexes(evCorrect, members), eceBins).e,
		}
	}

	const oa = bySource("oa")
	const corpus = bySource("corpus")
	const float = asPythonFloat

	return {
		nTotal: records.length,
		nFit: fitIndex.length,
		nEval: evalIndex.length,
		table: lookupTable(xs, g, bins),
		metrics: {
			ece_raw_eval: float(raw.e),
			ece_cal_eval: float(cal.e),
			mce_raw_eval: float(robustMCE(raw.rows)),
			mce_cal_eval: float(robustMCE(cal.rows)),
			mce_raw_eval_allbins: float(raw.mce),
			mce_cal_eval_allbins: float(cal.mce),
			brier_raw_eval: float(brier(evConf, evCorrect)),
			brier_cal_eval: float(brier(evCal, evCorrect)),
			ece_raw_oa_eval: float(oa.raw),
			ece_cal_oa_eval: float(oa.cal),
			ece_raw_corpus_eval: float(corpus.raw),
			ece_cal_corpus_eval: float(corpus.cal),
		},
		perTag: subgroupECE(
			atIndexes(
				records.map((r) => r.tag),
				evalIndex
			),
			evConf,
			evCal,
			evCorrect,
			eceBins
		),
		perLocale: subgroupECE(
			atIndexes(
				records.map((r) => r.country),
				evalIndex
			),
			evConf,
			evCal,
			evCorrect,
			eceBins
		),
		abstention: abstentionCurve(evCal, evCorrect),
		reliabilityRaw: raw.rows,
		reliabilityCal: cal.rows,
	}
}

/**
 * The table's provenance fields.
 */
export interface IsotonicRunOptions {
	model: string
	modelVersion: string
	createdFrom: string
	bins: number
	eceBins: number
}

/**
 * The lookup-table document: the table, its provenance and the held-out figures.
 */
export function buildPayload(options: IsotonicRunOptions, fit: IsotonicFit) {
	return {
		model: options.model,
		model_version: options.modelVersion,
		method: "isotonic-regression (PAVA) over per-span softmax confidence",
		created_from: options.createdFrom,
		n_total: fit.nTotal,
		n_fit: fit.nFit,
		n_eval: fit.nEval,
		bins: options.bins,
		ece_bins: options.eceBins,
		metrics: fit.metrics,
		per_tag_ece: fit.perTag,
		per_locale_ece: fit.perLocale,
		abstention_curve: fit.abstention,
		reliability_raw: fit.reliabilityRaw,
		reliability_cal: fit.reliabilityCal,
		table: fit.table,
	}
}

const f = (value: PythonFloat | number | null, digits: number) =>
	value == null ? "—" : pyFixed(typeof value === "number" ? value : value.value, digits)

function headlineLines(options: IsotonicRunOptions, fit: IsotonicFit): string[] {
	const m = fit.metrics

	return [
		`# Isotonic confidence calibration — ${options.model} v${options.modelVersion}`,
		"",
		"Post-hoc calibration of the decoder's per-span softmax confidence (the `conf=` a resolver or " +
			"human reads off the parse). Method: isotonic regression (PAVA) over `(raw confidence, correct?)` " +
			"pairs from a 50/50 OpenAddresses + training-corpus calibration set. Fit on 80%, every number below " +
			"measured on the held-out 20%. Task #59 (#240 PR3).",
		"",
		"> `correct?` is a normalized exact-or-token-subset span match (so street decomposition and " +
			"multi-word fragmentation aren't penalized), so the absolute accuracy runs mildly optimistic — " +
			"isotonic corrects the reliability _shape_, and the lenient threshold leaves that shape intact. The " +
			"corpus half is in-domain (the model trained on it). The OA-only row above is the trustworthy " +
			"held-out ECE.",
		"",
		"## Headline",
		"",
		"| Split | ECE raw | ECE calibrated | target |",
		"| --- | --- | --- | --- |",
		`| **Combined (deliverable)** | ${f(m.ece_raw_eval, 4)} | **${f(m.ece_cal_eval, 4)}** | \`<0.05\` |`,
		`| OA-only (held-out, trustworthy) | ${f(m.ece_raw_oa_eval, 4)} | ${f(m.ece_cal_oa_eval, 4)} | — |`,
		`| corpus-only (in-domain) | ${f(m.ece_raw_corpus_eval, 4)} | ${f(m.ece_cal_corpus_eval, 4)} | — |`,
		"",
		`MCE (bins n≥20) ${f(m.mce_raw_eval, 4)} → ${f(m.mce_cal_eval, 4)} · ` +
			`Brier ${f(m.brier_raw_eval, 4)} → ${f(m.brier_cal_eval, 4)} · ` +
			`n_fit=${fit.nFit} n_eval=${fit.nEval} spans.`,
		"",
		"> MCE is reported over bins with ≥20 samples. The model is confident — ~94% of held-out spans " +
			"sit in [0.93, 1.0] — so equal-width bins below ~0.7 hold a handful of samples each and their " +
			"all-bins max gap is single-sample noise rather than a calibration failure. ECE (sample-weighted) is " +
			"the headline. It weights each bin by its mass.",
		"",
	]
}

function reliabilityLines(title: string, rows: readonly ReliabilityBin[], label: string): string[] {
	const lines = [
		`## Reliability (held-out eval, ${title})`,
		"",
		`| confidence bin | n | mean ${label} | accuracy | gap |`,
		"| --- | --- | --- | --- | --- |",
	]

	for (const r of rows) {
		if (!r.n) continue

		const gap = Math.abs(r.conf!.value - r.acc!.value)

		lines.push(`| [${f(r.lo, 2)}, ${f(r.hi, 2)}) | ${r.n} | ${f(r.conf, 3)} | ${f(r.acc, 3)} | ${f(gap, 3)} |`)
	}

	lines.push("")

	return lines
}

function subgroupLines(title: string, groups: IsotonicFit["perTag"]): string[] {
	const lines = [
		`## ECE by ${title} (held-out eval, raw → calibrated)`,
		"",
		`| ${title} | n | accuracy | ECE raw | ECE calibrated |`,
		"| --- | ---: | ---: | ---: | ---: |",
	]

	for (const [key, v] of Object.entries(groups).toSorted((a, b) => b[1].ece_raw.value - a[1].ece_raw.value)) {
		lines.push(`| ${key} | ${v.n} | ${f(v.acc, 3)} | ${f(v.ece_raw, 4)} | ${f(v.ece_cal, 4)} |`)
	}

	lines.push("")

	return lines
}

function abstentionLines(fit: IsotonicFit): string[] {
	const lines = [
		"## Abstention curve (calibrated confidence)",
		"",
		"Accept spans at or above the threshold, and route the rest to review. Precision is the accuracy of the accepted set.",
		"",
		"| threshold | coverage (accepted) | precision | reviewed |",
		"| --- | ---: | ---: | ---: |",
	]

	for (const a of fit.abstention) {
		lines.push(
			`| ${f(a.threshold, 2)} | ${f(100 * a.coverage.value, 1)}% | ${f(100 * a.precision.value, 2)}% | ${f(100 * a.reviewed.value, 1)}% |`
		)
	}

	lines.push(
		"",
		"> The single global table is fit across all locales/tags, so it under-serves the worst-calibrated " +
			"subgroups — the per-locale rows show where the one-size table leaves residual error (the OOD " +
			"locales and rare tags run far higher than the US/FR-dominated global ECE). A per-locale table is " +
			"the natural next step once the deployed multi-locale model is the calibration target (#368).",
		""
	)

	return lines
}

function tableLines(fit: IsotonicFit): string[] {
	const lines = ["## 20-bin lookup table (raw → calibrated)", "", "| bin center | calibrated |", "| --- | --- |"]

	for (const row of fit.table) {
		lines.push(`| ${f(row.center, 3)} | ${f(row.calibrated, 3)} |`)
	}

	lines.push(
		"",
		"## How it's wired",
		"",
		"The table ships as `data/eval/calibration/isotonic-en-us-v4.0.0.json` and is turned into a " +
			"`(raw)=>calibrated` function by the OPT-IN decoder calibrator (`core/decoder/calibration.ts` → " +
			"`createCalibrator`). Default parse output is unchanged (byte-stable); pass the calibrator via " +
			"`ParseOpts.calibrate` / `BuildTreeOpts.calibrate` to emit calibrated `conf=`. Regenerate with " +
			"`scripts/eval/{build-calibration-set.py,collect-span-confidences.ts,fit-isotonic-calibration.py}`.",
		""
	)

	return lines
}

/**
 * The markdown report.
 * Every figure comes from the fit.
 */
export function renderCalibrationReport(options: IsotonicRunOptions, fit: IsotonicFit): string {
	return (
		[
			...headlineLines(options, fit),
			...reliabilityLines("raw confidence", fit.reliabilityRaw, "conf"),
			...reliabilityLines("calibrated confidence", fit.reliabilityCal, "cal"),
			...subgroupLines("locale", fit.perLocale),
			...subgroupLines("tag", fit.perTag),
			...abstentionLines(fit),
			...tableLines(fit),
		].join("\n") + "\n"
	)
}
