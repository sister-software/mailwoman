/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare post-hoc rejection scores with frozen weights. Keep routing fixed, select
 *   thresholds on development data, and report held-out results.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds nothing a reader wants folded. */

import { basename, type PathBuilderLike, resolvePath, resolvePathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { type CoarsePlacerMeta, readWeightsBin } from "#coarse-placer/coarse-placer"
import { COARSE_CLASSES, featurize } from "#coarse-placer/featurize"
import { logsumexp, softmaxInto } from "#coarse-placer/math"
import { defaultDataDir, defaultModelDir, readLatinOffmapRows } from "#coarse-placer/tools/paths"
import { readLocalJSONFile } from "#fs/readers"
import { writeLocalFile } from "#fs/writers"

/**
 * Number of quantiles evaluated per threshold sweep.
 */
const QUANTILE_SWEEP_STEPS = 200

/**
 * Target percentage for in-map accuracy and held-out catch.
 */
const TARGET_PERCENT = 90

type ScoreKey = "maxprob" | "p_inmap" | "energy" | "maxlogit" | "maha"

interface DataRow {
	raw: string
	country: string
	group?: string
	srcCountry?: string
	family?: string
}

interface ScoredRow {
	correctRoute: boolean
	s: Record<ScoreKey, number>
}

interface ParetoPoint {
	t: number
	inMapAcc: number
	heldCaught: number
}

/**
 * Options for {@linkcode evalOpenSet}.
 */
export interface EvalOpenSetOptions {
	/**
	 * Model artifact directory.
	 * Defaults to `$MAILWOMAN_DATA_ROOT/coarse-placer/model`.
	 */
	model?: PathBuilderLike
	/**
	 * Dataset directory.
	 * Defaults to `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
	/**
	 * Mahalanobis fit rows per class; defaults to 2000.
	 */
	fitPerClass?: number
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
}

/**
 * Result of {@linkcode evalOpenSet}.
 */
export interface EvalOpenSetResult {
	/**
	 * Score with the best held-out minimum of in-map accuracy and held-out catch.
	 */
	winner: ScoreKey
	honestMin: number
	clears90: boolean
	markdown: string
}

/**
 * Invert a matrix with Gauss-Jordan elimination.
 */
function inverse(M: Float64Array[]): number[][] {
	const n = M.length

	const A = M.map((row, i) => {
		const r = new Float64Array(2 * n)

		for (let j = 0; j < n; j++) {
			r[j] = row[j]!
		}

		r[n + i] = 1

		return r
	})

	for (let col = 0; col < n; col++) {
		let piv = col

		for (let r = col + 1; r < n; r++)
			if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) {
				piv = r
			}

		;[A[col], A[piv]] = [A[piv]!, A[col]!]
		const d = A[col]![col]!

		for (let j = 0; j < 2 * n; j++) {
			A[col]![j] = A[col]![j]! / d
		}

		for (let r = 0; r < n; r++) {
			if (r === col) continue
			const f = A[r]![col]!

			for (let j = 0; j < 2 * n; j++) {
				A[r]![j] = A[r]![j]! - f * A[col]![j]!
			}
		}
	}

	return A.map((r) => Array.from(r.slice(n)))
}

/**
 * Compare open-set scores and emit a Markdown report.
 */
export async function evalOpenSet(
	options: EvalOpenSetOptions = {},
	report?: (line: string) => void
): Promise<EvalOpenSetResult> {
	const modelDir = resolvePathBuilder(options.model || defaultModelDir())
	const dataDir = options.data || defaultDataDir()
	const fitPerClass = options.fitPerClass ?? 2000

	const meta = await readLocalJSONFile<CoarsePlacerMeta>(resolvePath(modelDir, "meta.json"))
	const W = new Float32Array(await readWeightsBin(resolvePath(modelDir)))

	const bias = Float32Array.from(meta.bias)
	const C = meta.classes.length
	const D = meta.featureDim
	const OTHER = meta.classes.indexOf("OTHER")
	const IN = meta.classes.map((_, i) => i).filter((i) => i !== OTHER) // in-map class indices
	const nIn = IN.length

	if (W.length !== C * D) throw new Error(`weights ${W.length} ≠ ${C}×${D}`)

	/**
	 * Return uncalibrated logits for all classes.
	 */
	function logits(raw: string): Float64Array {
		const feats = featurize(raw)
		const z = new Float64Array(C)

		for (let c = 0; c < C; c++) {
			let s = bias[c]!
			const base = c * D

			for (const i of feats) {
				s += W[base + i]!
			}

			z[c] = s
		}

		return z
	}

	/**
	 * Return in-map logits in class order.
	 */
	const inVec = (z: Float64Array): number[] => IN.map((c) => z[c]!)

	function load(file: string) {
		return JSONSpliterator.fromAsync<DataRow>(resolvePath(dataDir, file))
	}

	// Fit class means and shared covariance from in-map training logits.
	report?.("fitting Mahalanobis on in-map train logits…")
	const trainRows = load("train.jsonl")
	const byClass = new Map<string, string[]>(COARSE_CLASSES.map((c): [string, string[]] => [c, []]))

	for await (const r of trainRows) {
		if (r.country === "OTHER") continue
		const arr = byClass.get(r.country)

		if (arr && arr.length < fitPerClass) {
			arr.push(r.raw)
		}
	}

	const means = new Map<string, Float64Array>() // Country-to-mean-logit mapping.
	const counts = new Map<string, number>()

	// Compute per-class means.
	for (const [country, raws] of byClass) {
		if (!raws.length) continue
		const mu = new Float64Array(nIn)

		for (const raw of raws) {
			const v = inVec(logits(raw))

			for (let k = 0; k < nIn; k++) {
				mu[k] = mu[k]! + v[k]!
			}
		}

		for (let k = 0; k < nIn; k++) {
			mu[k] = mu[k]! / raws.length
		}

		means.set(country, mu)
		counts.set(country, raws.length)
	}

	// Compute shared covariance from centered logits.
	const Sigma = Array.from({ length: nIn }, () => new Float64Array(nIn))
	let nTot = 0

	for (const [country, raws] of byClass) {
		const mu = means.get(country)

		if (!mu) continue

		for (const raw of raws) {
			const v = inVec(logits(raw))
			const d = new Float64Array(nIn)

			for (let k = 0; k < nIn; k++) {
				d[k] = v[k]! - mu[k]!
			}

			for (let a = 0; a < nIn; a++) {
				for (let b = 0; b < nIn; b++) {
					Sigma[a]![b] = Sigma[a]![b]! + d[a]! * d[b]!
				}
			}

			nTot++
		}
	}

	for (let a = 0; a < nIn; a++) {
		for (let b = 0; b < nIn; b++) {
			Sigma[a]![b] = Sigma[a]![b]! / nTot
		}
	}

	// Add diagonal regularization before inversion.
	for (let a = 0; a < nIn; a++) {
		Sigma[a]![a] = Sigma[a]![a]! + 1e-3
	}

	const SigmaInv = inverse(Sigma)

	/**
	 * Return the negative minimum Mahalanobis distance to a class mean.
	 */
	function mahaScore(z: Float64Array): number {
		const v = inVec(z)
		let best = Infinity

		for (const mu of means.values()) {
			const d = new Float64Array(nIn)

			for (let k = 0; k < nIn; k++) {
				d[k] = v[k]! - mu[k]!
			}

			let q = 0

			for (let a = 0; a < nIn; a++) {
				let row = 0

				for (let b = 0; b < nIn; b++) {
					row += SigmaInv[a]![b]! * d[b]!
				}

				q += d[a]! * row
			}

			if (q < best) {
				best = q
			}
		}

		return -best
	}

	// Score in-map test and held-out data.

	report?.("scoring in-map test + off-map heldout…")
	const SCORES: ScoreKey[] = ["maxprob", "p_inmap", "energy", "maxlogit", "maha"]

	/**
	 * Score one address and check its in-map route against the label.
	 */
	function scoreRow(raw: string, trueCountry: string | undefined): ScoredRow {
		const z = logits(raw)
		const probs = new Float64Array(C)

		softmaxInto(z, probs)
		const zin = inVec(z)

		// Route by the in-map argmax for every score.
		let amIdx = 0,
			am = -Infinity

		for (let k = 0; k < nIn; k++)
			if (zin[k]! > am) {
				am = zin[k]!
				amIdx = k
			}

		const routedCountry = COARSE_CLASSES[IN[amIdx]!]!
		const inmapProbMax = Math.max(...IN.map((c) => probs[c]!))

		return {
			correctRoute: trueCountry !== undefined && routedCountry === trueCountry,
			s: {
				maxprob: inmapProbMax,
				p_inmap: 1 - probs[OTHER]!,
				energy: logsumexp(zin),
				maxlogit: Math.max(...zin),
				maha: mahaScore(z),
			},
		}
	}

	// Score in-map test rows.
	const inmapScored = await load("test.jsonl")
		.filter((r) => r.country !== "OTHER")
		.map((r) => scoreRow(r.raw, r.country))
		.toArray()

	const heldout = (await readLatinOffmapRows<DataRow>(dataDir)).filter((r) => r.group === "heldout")

	const heldoutScored = heldout.map((r) => scoreRow(r.raw, undefined))

	// Select thresholds on even-indexed rows; evaluate on odd-indexed rows.
	const inDev = inmapScored.filter((_, i) => i % 2 === 0)
	const inTest = inmapScored.filter((_, i) => i % 2 === 1)
	const heldDev = heldoutScored.filter((_, i) => i % 2 === 0)
	const heldTest = heldoutScored.filter((_, i) => i % 2 === 1)

	/**
	 * Measure in-map accuracy and held-out catch at threshold `t`.
	 */
	function pointAt(scoreKey: ScoreKey, t: number, inSplit: ScoredRow[], heldSplit: ScoredRow[]): ParetoPoint {
		let keepCorrect = 0

		for (const o of inSplit)
			if (o.s[scoreKey] >= t && o.correctRoute) {
				keepCorrect++
			}

		let caught = 0

		for (const o of heldSplit)
			if (o.s[scoreKey] < t) {
				caught++
			}

		return { t, inMapAcc: (100 * keepCorrect) / inSplit.length, heldCaught: (100 * caught) / heldSplit.length }
	}

	// Keep scores at or above the threshold; reject the rest.
	function paretoFor(scoreKey: ScoreKey) {
		// Sweep quantiles across both datasets.
		const all = [...inmapScored, ...heldoutScored].map((o) => o.s[scoreKey]).toSorted((a, b) => a - b)
		const ts: number[] = []

		for (let q = 0; q <= QUANTILE_SWEEP_STEPS; q++) {
			ts.push(all[Math.min(all.length - 1, Math.floor((q / 200) * (all.length - 1)))]!)
		}

		const uniq = [...new Set(ts)]
		const pts: ParetoPoint[] = uniq.map((t) => pointAt(scoreKey, t, inmapScored, heldoutScored))

		// Find the balanced point and best values at each target constraint.
		let balanced: { val: number; pt: ParetoPoint | null } = { val: -1, pt: null }
		let atHeld90: ParetoPoint | null = null // Best in-map accuracy at the held-out target.
		let atIn90: ParetoPoint | null = null

		// Best held-out catch at the in-map target.
		for (const p of pts) {
			const m = Math.min(p.inMapAcc, p.heldCaught)

			if (m > balanced.val) {
				balanced = { val: m, pt: p }
			}

			if (p.heldCaught >= TARGET_PERCENT && (!atHeld90 || p.inMapAcc > atHeld90.inMapAcc)) {
				atHeld90 = p
			}

			if (p.inMapAcc >= TARGET_PERCENT && (!atIn90 || p.heldCaught > atIn90.heldCaught)) {
				atIn90 = p
			}
		}

		// Select the balanced threshold on development data and evaluate it on test data.
		let devBest: { val: number; t: number | null } = { val: -1, t: null }

		for (const p of pts) {
			const d = pointAt(scoreKey, p.t, inDev, heldDev)
			const m = Math.min(d.inMapAcc, d.heldCaught)

			if (m > devBest.val) {
				devBest = { val: m, t: p.t }
			}
		}

		const heldoutTestPt = pointAt(scoreKey, devBest.t!, inTest, heldTest)

		return { balanced, atHeld90, atIn90, devThreshold: devBest.t, honest: heldoutTestPt, pts }
	}

	type Pareto = ReturnType<typeof paretoFor>
	const results = Object.fromEntries(SCORES.map((k) => [k, paretoFor(k)])) as Record<ScoreKey, Pareto>

	// Assemble the report.

	const f = (x: number | null | undefined): string => (x == null ? "—" : x.toFixed(1))

	const lines: string[] = [
		`# Coarse-placer M2 Phase 1 — post-hoc open-set score comparison (#244)`,
		"",
		`_Frozen shipped model (\`${basename(modelDir)}\`), NO retrain. In-map test ${inmapScored.length} rows ` +
			`(11 countries); off-map HELDOUT ${heldout.length} rows (never-trained families: baltic/oceania/middle-east). ` +
			`Mahalanobis fit on ≤${fitPerClass}/class in-map train logits. The 11-way routing is fixed; each score only ` +
			`changes the reject decision._`,
		"",
	]

	function atStr(p: ParetoPoint | null): string {
		if (!p) return "— (unreachable)"

		return `in ${f(p.inMapAcc)} / held ${f(p.heldCaught)}`
	}

	lines.push(`## Honest dev→test point (threshold picked on dev, frozen on test)`)
	lines.push("")
	lines.push(`| score | TEST in-map | TEST held-caught | min | full-probe balanced |`)
	lines.push(`|---|---:|---:|---:|---:|`)

	for (const k of SCORES) {
		const r = results[k]
		const h = r.honest

		lines.push(
			`| \`${k}\` | ${f(h.inMapAcc)} | ${f(h.heldCaught)} | **${f(Math.min(h.inMapAcc, h.heldCaught))}** | ${f(r.balanced.val)} |`
		)
	}

	lines.push("")
	lines.push(`## Full-probe corners (the achievable Pareto), per score`)
	lines.push("")
	lines.push(`| score | balanced min(in,held) | in-map @ held≥90 | held @ in-map≥90 |`)
	lines.push(`|---|---:|---:|---:|`)

	for (const k of SCORES) {
		const r = results[k]
		const bal = r.balanced.pt

		lines.push(
			`| \`${k}\` | **${f(r.balanced.val)}** (in ${f(bal?.inMapAcc)}, held ${f(bal?.heldCaught)}) | ` +
				`${atStr(r.atHeld90)} | ${atStr(r.atIn90)} |`
		)
	}

	lines.push("")

	// Rank scores by their held-out minimum.
	const ranked = SCORES.map((k) => ({
		k,
		honestMin: Math.min(results[k].honest.inMapAcc, results[k].honest.heldCaught),
	})).toSorted((a, b) => b.honestMin - a.honestMin)

	const winner = ranked[0]!
	const clears90 = winner.honestMin >= TARGET_PERCENT
	lines.push(`## Verdict`)
	lines.push("")

	lines.push(
		`Best score (honest dev→test): **\`${winner.k}\`** at min(in-map, heldout) = **${f(winner.honestMin)}** on the frozen test half. ` +
			(clears90
				? `**Clears 90/90 post-hoc** — wire it into CoarsePlacer as the open-set reject rule; no retrain needed (Phase 2 reject-head unnecessary).`
				: `Below the 90/90 bar — the best post-hoc score reaches ${f(winner.honestMin)}. Escalate to Phase 2 (explicit binary reject head).`)
	)

	lines.push("")
	lines.push(`Ranking (honest dev→test min): ${ranked.map((r) => `\`${r.k}\` ${f(r.honestMin)}`).join(" · ")}`)
	lines.push("")

	const md = lines.join("\n")

	console.log(md)

	if (options.outMd) {
		await writeLocalFile(md, options.outMd)
		report?.(`\n[written] ${options.outMd}`)
	}

	return { winner: winner.k, honestMin: winner.honestMin, clears90, markdown: md }
}
