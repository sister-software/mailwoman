/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #244 M2 Phase 1 — POST-HOC open-set scoring on the EXISTING (shipped) coarse-placer, NO retrain.
 *   The OA-breadth verdict found the 12-way softmax's own max-prob detector tops out at ~88/88 on
 *   the leave-one-family-out probe (in-map accuracy vs off-map HELDOUT-family caught). This asks:
 *   does a DIFFERENT open-set score, read off the same frozen weights, clear the 90/90 the softmax
 *   can't?
 *
 *   The 11-way routing (argmax over the in-map classes) is FIXED — the model is unchanged. The only
 *   thing each score changes is the REJECT decision (keep the in-map route vs. abstain → OTHER). We
 *   sweep each score's threshold and trace its (in-map accuracy, heldout-caught) Pareto.
 *
 *   Scores compared (all functions of the frozen 12 logits / 11 in-map logits `z`):
 *
 *   - Maxprob : softmax max over the 11 in-map classes (the verdict's baseline detector)
 *   - P_inmap : 1 - P(OTHER) (trust the model's own OTHER head)
 *   - Energy : logsumexp(z) (free-energy; higher = more in-map)
 *   - Maxlogit : max(z)
 *   - Maha : -min_c (z-μ_c)ᵀ Σ⁻¹ (z-μ_c), class-conditional Gaussians (tied Σ) fit on in-map TRAIN
 *       logits (Lee et al. 2018, in the 11-dim in-map-logit space — the linear model's only dense
 *       representation). Higher = closer to the in-map manifold.
 *
 *   In-map accuracy = of the 11-country test rows, fraction NOT rejected AND argmax-in-map == truth.
 *   heldout caught = of the never-trained off-map families (baltic/oceania/middle-east), fraction
 *   rejected. Both move with the threshold; the Pareto is the whole story.
 *
 *   Run: `mailwoman placer eval openset [--model <dir>] [--out-md <path>]`
 */

import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { dataRootPath } from "../../utils/data-root.ts"
import { repoRootPath } from "../../utils/repo.ts"
import type { CoarsePlacerMeta } from "../coarse-placer.ts"
import { COARSE_CLASSES, featurize } from "../featurize.ts"

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

/** Options for {@linkcode evalOpenSet}. */
export interface EvalOpenSetOptions {
	/** Model artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`. */
	model?: string
	/** Dataset dir. Default `<repo>/data/coarse-placer`. */
	data?: string
	/** Mahalanobis fit rows per class. Default 2000. */
	fitPerClass?: number
	/** Also write the markdown report here. */
	outMd?: string
}

/** Result of {@linkcode evalOpenSet}. */
export interface EvalOpenSetResult {
	/** Best score by the honest dev→test balanced min. */
	winner: ScoreKey
	honestMin: number
	clears90: boolean
	markdown: string
}

function logsumexp(xs: number[]): number {
	let m = -Infinity

	for (const x of xs)
		if (x > m) {
			m = x
		}
	let s = 0

	for (const x of xs) {
		s += Math.exp(x - m)
	}

	return m + Math.log(s)
}

/** Per-class softmax prob over ALL 12 classes. */
function softmax(z: Float64Array): Float64Array {
	const m = Math.max(...z)
	const e = z.map((x) => Math.exp(x - m))
	const s = e.reduce((a, b) => a + b, 0)

	return e.map((x) => x / s)
}

/** Invert a symmetric positive-definite matrix via Gauss-Jordan. */
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

/** Coarse-placer post-hoc open-set score comparison — see the module doc. Emits the markdown report to stdout. */
export async function evalOpenSet(
	options: EvalOpenSetOptions = {},
	report?: (line: string) => void
): Promise<EvalOpenSetResult> {
	const modelDir = options.model || dataRootPath("coarse-placer", "model")
	const dataDir = options.data || repoRootPath("data", "coarse-placer")
	const fitPerClass = options.fitPerClass ?? 2000

	const meta = JSON.parse(readFileSync(path.join(modelDir, "meta.json"), "utf8")) as CoarsePlacerMeta
	const W = new Float32Array(readFileSync(path.join(modelDir, "weights.bin")).buffer)
	const bias = Float32Array.from(meta.bias)
	const C = meta.classes.length
	const D = meta.featureDim
	const OTHER = meta.classes.indexOf("OTHER")
	const IN = meta.classes.map((_, i) => i).filter((i) => i !== OTHER) // in-map class indices
	const nIn = IN.length

	if (W.length !== C * D) throw new Error(`weights ${W.length} ≠ ${C}×${D}`)

	/** Raw logits (PRE-temperature) for the 12 classes. OOD scores use the geometry, not calibration. */
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

	/** In-map logit sub-vector (length nIn), in IN order. */
	const inVec = (z: Float64Array): number[] => IN.map((c) => z[c]!)

	function load(file: string): DataRow[] {
		return readFileSync(path.join(dataDir, file), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as DataRow)
	}

	// ---------------------------------------------------------------------------
	// Fit the Mahalanobis params on IN-MAP TRAIN logits (no test leak): per-class
	// mean in the nIn-dim in-map-logit space + a tied (shared) covariance.
	// ---------------------------------------------------------------------------
	report?.("fitting Mahalanobis on in-map train logits…")
	const trainRows = load("train.jsonl")
	const byClass = new Map<string, string[]>(COARSE_CLASSES.map((c): [string, string[]] => [c, []]))

	for (const r of trainRows) {
		if (r.country === "OTHER") continue
		const arr = byClass.get(r.country)

		if (arr && arr.length < fitPerClass) {
			arr.push(r.raw)
		}
	}
	const means = new Map<string, Float64Array>() // country -> Float64Array(nIn)
	const counts = new Map<string, number>()

	// Accumulate per-class means.
	for (const [country, raws] of byClass) {
		if (raws.length === 0) continue
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
	// Tied covariance over centered in-map train logits.
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

	// Ridge for invertibility.
	for (let a = 0; a < nIn; a++) {
		Sigma[a]![a] = Sigma[a]![a]! + 1e-3
	}

	const SigmaInv = inverse(Sigma)

	/** -min_c Mahalanobis² to any in-map class mean (higher = closer to the in-map manifold). */
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

	// ---------------------------------------------------------------------------
	// Score the in-map test (11 countries) + the off-map heldout families.
	// ---------------------------------------------------------------------------
	report?.("scoring in-map test + off-map heldout…")
	const SCORES: ScoreKey[] = ["maxprob", "p_inmap", "energy", "maxlogit", "maha"]

	/** All open-set scores for one raw string + whether argmax-in-map routes to `trueCountry`. */
	function scoreRow(raw: string, trueCountry: string | undefined): ScoredRow {
		const z = logits(raw)
		const probs = softmax(z)
		const zin = inVec(z)
		// argmax over in-map classes (the FIXED routing).
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

	const inmapTest = load("test.jsonl").filter((r) => r.country !== "OTHER") // the 11 countries only
	const heldout = load("test-latin-offmap.jsonl").filter((r) => r.group === "heldout")

	const inmapScored = inmapTest.map((r) => scoreRow(r.raw, r.country))
	const heldoutScored = heldout.map((r) => scoreRow(r.raw, undefined))

	// Honest threshold protocol: split each probe 50/50 (deterministic by index parity) into DEV + TEST.
	// The operating threshold is picked on DEV (maximizing balanced min); the reported point is frozen on
	// TEST — so the number is a generalization estimate, not a threshold fit to the set it's scored on.
	const inDev = inmapScored.filter((_, i) => i % 2 === 0)
	const inTest = inmapScored.filter((_, i) => i % 2 === 1)
	const heldDev = heldoutScored.filter((_, i) => i % 2 === 0)
	const heldTest = heldoutScored.filter((_, i) => i % 2 === 1)

	/** (inMapAcc, heldCaught) at threshold t over a given in-map/heldout split. */
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

	// For each score: KEEP (route in-map) iff score >= threshold; else REJECT (→ OTHER).
	// in-map accuracy = keep & correctRoute. heldout caught = rejected.
	function paretoFor(scoreKey: ScoreKey) {
		const inVals = inmapScored.map((o) => ({ v: o.s[scoreKey], ok: o.correctRoute }))
		const heldVals = heldoutScored.map((o) => o.s[scoreKey])
		// Candidate thresholds: quantiles of the union of scores.
		const all = [...inVals.map((x) => x.v), ...heldVals].sort((a, b) => a - b)
		const ts: number[] = []

		for (let q = 0; q <= 200; q++) {
			ts.push(all[Math.min(all.length - 1, Math.floor((q / 200) * (all.length - 1)))]!)
		}
		const uniq = [...new Set(ts)]
		const nInVals = inVals.length
		const nHeld = heldVals.length
		const pts: ParetoPoint[] = uniq.map((t) => {
			let keepCorrect = 0

			for (const x of inVals)
				if (x.v >= t && x.ok) {
					keepCorrect++
				}
			let caught = 0

			for (const v of heldVals)
				if (v < t) {
					caught++
				}

			return { t, inMapAcc: (100 * keepCorrect) / nInVals, heldCaught: (100 * caught) / nHeld }
		})
		// Summaries.
		let balanced: { val: number; pt: ParetoPoint | null } = { val: -1, pt: null } // max of min(inMapAcc, heldCaught) on the FULL probe
		let atHeld90: ParetoPoint | null = null // highest inMapAcc with heldCaught >= 90
		let atIn90: ParetoPoint | null = null

		// highest heldCaught with inMapAcc >= 90
		for (const p of pts) {
			const m = Math.min(p.inMapAcc, p.heldCaught)

			if (m > balanced.val) {
				balanced = { val: m, pt: p }
			}

			if (p.heldCaught >= 90 && (!atHeld90 || p.inMapAcc > atHeld90.inMapAcc)) {
				atHeld90 = p
			}

			if (p.inMapAcc >= 90 && (!atIn90 || p.heldCaught > atIn90.heldCaught)) {
				atIn90 = p
			}
		}

		// HONEST point: pick t* on DEV (max balanced min), freeze + report on TEST.
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

	// ---------------------------------------------------------------------------
	// Report.
	// ---------------------------------------------------------------------------
	const f = (x: number | null | undefined): string => (x == null ? "—" : x.toFixed(1))
	const lines: string[] = []
	lines.push(`# Coarse-placer M2 Phase 1 — post-hoc open-set score comparison (#244)`)
	lines.push("")
	lines.push(
		`_Frozen shipped model (\`${path.basename(modelDir)}\`), NO retrain. In-map test ${inmapTest.length} rows ` +
			`(11 countries); off-map HELDOUT ${heldout.length} rows (never-trained families: baltic/oceania/middle-east). ` +
			`Mahalanobis fit on ≤${fitPerClass}/class in-map train logits. The 11-way routing is fixed; each score only ` +
			`changes the reject decision._`
	)
	lines.push("")
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

	// Winner by the HONEST dev→test balanced min (not the full-probe number).
	const ranked = SCORES.map((k) => ({
		k,
		honestMin: Math.min(results[k].honest.inMapAcc, results[k].honest.heldCaught),
	})).sort((a, b) => b.honestMin - a.honestMin)
	const winner = ranked[0]!
	const clears90 = winner.honestMin >= 90
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
		writeFileSync(options.outMd, md)
		report?.(`\n[written] ${options.outMd}`)
	}

	return { winner: winner.k, honestMin: winner.honestMin, clears90, markdown: md }
}
