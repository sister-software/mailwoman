/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Held-out fresh-draw Gauntlet — THE generalization gate (DeepSeek 019f1144: "the only layer that
 *   measures the tail; when it conflicts with the curated suite, it wins"). Each run draws a FRESH random
 *   sample with truth coordinates (BAN for FR), so the model can't memorize it, and runs BOTH the candidate
 *   and the current production model on the SAME draw. It gates on a two-proportion z-test: ship only if the
 *   candidate is NOT statistically worse than production at the locality tolerance. Absolute accuracy is not
 *   the gate — the candidate-vs-prod DELTA is (this controls for data drift + coverage gaps).
 *
 *   Run: node scripts/eval/gauntlet/holdout.ts --candidate ./out/v194-final/model.onnx [--n 300]
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

import { haversineKm } from "@mailwoman/spatial"
import { mailwomanDataRoot } from "mailwoman/resolver-backend"

import { arg } from "../../lib/cli-args.ts"
import { buildGauntletDeps, type GauntletDeps } from "./harness.ts"

const N = Number(arg("n", "300"))
const CANDIDATE = arg("candidate", "")
const BAN = `${mailwomanDataRoot()}/corpus/staging/ban-france.csv`
// BAN columns: numero(2) rep(3) nom_voie(4) nom_commune(7) lon(12) lat(13)
const C = { numero: 2, rep: 3, voie: 4, commune: 7, lon: 12, lat: 13 }
const TOLS = [0.1, 0.5, 5] as const // rooftop / street / locality (km)
const GATE_TOL = 5 // the z-test runs at the locality bucket (the dominant resolvable tier)

interface Sample {
	query: string
	lat: number
	lon: number
}

/** Reservoir-sample N rows with truth coords from the (streamed) BAN csv — a genuinely fresh draw each run. */
async function draw(n: number): Promise<Sample[]> {
	const rl = createInterface({ input: createReadStream(BAN, { encoding: "utf8" }), crlfDelay: Infinity })
	const res: Sample[] = []
	let seen = 0
	let line = 0

	for await (const raw of rl) {
		if (line++ === 0) continue // header
		const c = raw.split(";")
		const voie = (c[C.voie] ?? "").trim()
		const numero = (c[C.numero] ?? "").trim()
		const commune = (c[C.commune] ?? "").trim()
		const lat = Number(c[C.lat])
		const lon = Number(c[C.lon])

		if (!voie || !numero || !commune || !voie.includes(" ") || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
		// BARE form, no postcode — the hard case the tail actually exercises.
		const s: Sample = { query: `${numero} ${voie}, ${commune}`, lat, lon }
		seen++

		if (res.length < n) res.push(s)
		else {
			const j = Math.floor(Math.random() * seen)

			if (j < n) res[j] = s
		}
	}

	return res
}

async function score(deps: GauntletDeps, sample: Sample[]): Promise<{ hits: number[]; resolved: number }> {
	const hits = TOLS.map(() => 0)
	let resolved = 0

	for (const s of sample) {
		const g = await deps.geocode(s.query)

		if (g.lat == null || g.lon == null) continue
		resolved++
		const km = haversineKm(g.lat, g.lon, s.lat, s.lon)
		TOLS.forEach((t, i) => {
			if (km <= t) hits[i]++
		})
	}

	return { hits, resolved }
}

/** Two-proportion z (candidate − prod). z < −1.96 → candidate significantly WORSE (block). */
function zStat(cand: number, prod: number, n: number): number {
	const pc = cand / n
	const pp = prod / n
	const pool = (cand + prod) / (2 * n)
	const se = Math.sqrt(pool * (1 - pool) * (2 / n))

	return se === 0 ? 0 : (pc - pp) / se
}

if (!CANDIDATE) {
	console.error("Usage: holdout.ts --candidate <model.onnx> [--n 300]")
	process.exit(2)
}
console.error(`[gauntlet/holdout] drawing ${N} fresh BAN addresses…`)
const sample = await draw(N)
console.error(`[gauntlet/holdout] scoring production vs candidate on the SAME ${sample.length} addresses…`)

const prodDeps = await buildGauntletDeps({})
const prod = await score(prodDeps, sample)
prodDeps.close()

const candDeps = await buildGauntletDeps({ modelPath: CANDIDATE })
const cand = await score(candDeps, sample)
candDeps.close()

const n = sample.length
const gateIdx = TOLS.indexOf(GATE_TOL as (typeof TOLS)[number])
const z = zStat(cand.hits[gateIdx]!, prod.hits[gateIdx]!, n)

console.log(`\n=== Gauntlet · held-out fresh draw (FR/BAN, n=${n}) ===`)
console.log(`  tolerance     production   candidate`)
TOLS.forEach((t, i) => {
	console.log(`  ≤${String(t).padEnd(5)}km   ${String(prod.hits[i]).padStart(8)}     ${String(cand.hits[i]).padStart(8)}`)
})
console.log(`  resolved      ${String(prod.resolved).padStart(8)}     ${String(cand.resolved).padStart(8)}`)
console.log(`\n  z (candidate − production) @ ≤${GATE_TOL}km: ${z.toFixed(2)}`)
// Block ONLY on a significant regression. Candidate ahead or within noise → pass.
const pass = z >= -1.96
console.log(`  verdict: ${pass ? "PASS (candidate not significantly worse)" : "FAIL (candidate significantly worse — do not ship)"}`)
process.exit(pass ? 0 : 1)
