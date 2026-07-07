/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Paired A/B bootstrap over two per-row coord dumps (`fr-admin-split-gate.ts --dump-rows`) built on the
 *   SAME golden, index-aligned. Reports point estimates plus 95% bootstrap CIs for the candidate-minus-
 *   baseline diff in (a) resolve-rate and (b) resolved-p50 coordinate error, and applies a verdict per --mode:
 *
 *     ni       — non-inferiority (the US hard floor): resolved-p50 diff CI upper bound <= --ni-delta km
 *                AND resolve-rate diff CI lower bound >= -(--resolve-floor). A candidate that resolves
 *                fewer rows OR resolves them less accurately (beyond the delta) fails.
 *     improve  — a real improvement reaching the coordinate (the CZ/PL fix claim): resolved-p50 diff CI
 *                upper bound < 0 (wholly negative) OR resolve-rate diff CI lower bound > 0. Content-gap
 *                shrinking is necessary but not sufficient — the pin has to actually move.
 *     nochange — report only, no pass/fail.
 *
 *   Resampling is paired: one index multiset per rep, applied to BOTH dumps, so the diff CI accounts for
 *   the shared golden. p50 within a rep is over the rows RESOLVED by that model in the sampled multiset
 *   (resolved-only, unconfounded by the unresolved penalty — the resolve-rate diff carries coverage).
 *
 *   Usage:
 *     node --experimental-strip-types scripts/eval/coord-ab-bootstrap.ts \
 *       --baseline /tmp/gate/us-v4150.rows.jsonl --candidate /tmp/gate/us-v196.rows.jsonl \
 *       --mode ni --ni-delta 1 --resolve-floor 0.03 --label us
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { SeededRandom } from "@mailwoman/core/utils"

interface Row {
	i: number
	resolved: boolean
	err_km: number | null
}

function load(path: string): Row[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Row)
}

function median(xs: number[]): number {
	if (!xs.length) return NaN

	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)

	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Linear-interpolated percentile (matches the fr-admin-split-gate `pct` shape). */
function pct(xs: number[], p: number): number {
	if (!xs.length) return NaN

	const s = [...xs].sort((a, b) => a - b)
	const idx = (p / 100) * (s.length - 1)
	const lo = Math.floor(idx)
	const hi = Math.ceil(idx)

	return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (idx - lo)
}

const { values } = parseArgs({
	options: {
		baseline: { type: "string" },
		candidate: { type: "string" },
		reps: { type: "string", default: "10000" },
		seed: { type: "string", default: "42" },
		mode: { type: "string", default: "nochange" }, // ni | improve | nochange
		"ni-delta": { type: "string", default: "1" }, // km — non-inferiority margin on resolved-p50
		"resolve-floor": { type: "string", default: "0.03" }, // proportion — max tolerated resolve-rate drop
		label: { type: "string", default: "ab" },
	},
})

if (!values.baseline || !values.candidate) {
	console.error("usage: coord-ab-bootstrap.ts --baseline <rows.jsonl> --candidate <rows.jsonl> [--mode ni|improve]")
	process.exit(2)
}

const base = load(values.baseline)
const cand = load(values.candidate)

if (base.length !== cand.length) {
	throw new Error(`dumps differ in length (${base.length} vs ${cand.length}) — not the same golden`)
}

const n = base.length
const reps = Number(values.reps)
const rng = new SeededRandom(Number(values.seed))

// Point estimates.
const rrBase = base.filter((r) => r.resolved).length / n
const rrCand = cand.filter((r) => r.resolved).length / n
const p50Base = median(base.filter((r) => r.resolved).map((r) => r.err_km!))
const p50Cand = median(cand.filter((r) => r.resolved).map((r) => r.err_km!))

// Paired bootstrap.
const dResolve: number[] = []
const dP50: number[] = []

for (let r = 0; r < reps; r++) {
	let rb = 0
	let rc = 0
	const eb: number[] = []
	const ec: number[] = []

	for (let k = 0; k < n; k++) {
		const j = rng.randint(0, n - 1)

		if (base[j]!.resolved) {
			rb++
			eb.push(base[j]!.err_km!)
		}

		if (cand[j]!.resolved) {
			rc++
			ec.push(cand[j]!.err_km!)
		}
	}

	dResolve.push(rc / n - rb / n)

	if (eb.length && ec.length) {
		dP50.push(median(ec) - median(eb))
	}
}

const round = (x: number) => +x.toFixed(4)
const ci = (xs: number[]) => [round(pct(xs, 2.5)), round(pct(xs, 97.5))] as const

const resolveCI = ci(dResolve)
const p50CI = ci(dP50)
const niDelta = Number(values["ni-delta"])
const resolveFloor = Number(values["resolve-floor"])

let verdict: "PASS" | "FAIL" | "REPORT" = "REPORT"
const reasons: string[] = []

if (values.mode === "ni") {
	const p50OK = p50CI[1] <= niDelta
	const resolveOK = resolveCI[0] >= -resolveFloor
	verdict = p50OK && resolveOK ? "PASS" : "FAIL"
	reasons.push(`resolved-p50 diff CI upper ${p50CI[1]} <= ${niDelta}km → ${p50OK ? "ok" : "FAIL"}`)
	reasons.push(`resolve-rate diff CI lower ${resolveCI[0]} >= ${-resolveFloor} → ${resolveOK ? "ok" : "FAIL"}`)
} else if (values.mode === "improve") {
	const p50Better = p50CI[1] < 0
	const resolveBetter = resolveCI[0] > 0
	verdict = p50Better || resolveBetter ? "PASS" : "FAIL"
	reasons.push(`resolved-p50 diff CI upper ${p50CI[1]} < 0 → ${p50Better ? "improvement" : "no"}`)
	reasons.push(`resolve-rate diff CI lower ${resolveCI[0]} > 0 → ${resolveBetter ? "improvement" : "no"}`)
}

const out = {
	label: values.label,
	mode: values.mode,
	n,
	reps,
	resolve_rate: { baseline: round(rrBase), candidate: round(rrCand), diff: round(rrCand - rrBase), ci95: resolveCI },
	resolved_p50_km: { baseline: round(p50Base), candidate: round(p50Cand), diff: round(p50Cand - p50Base), ci95: p50CI },
	verdict,
	reasons,
}

console.log(JSON.stringify(out, null, 2))
