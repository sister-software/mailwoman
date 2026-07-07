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
import { parseArgs } from "node:util"

import { haversineKm } from "@mailwoman/spatial"
import { mailwomanDataRoot } from "mailwoman/resolver-backend"

import { buildGauntletDeps, type GauntletDeps } from "./harness.ts"

// Loose scan parity with the retired scripts/lib/cli-args helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: { candidate: { type: "string" }, n: { type: "string" }, source: { type: "string" } },
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { candidate?: string; n?: string; source?: string }
const N = Number(values["n"] || "300")
const CANDIDATE = values["candidate"] || ""
const SOURCE = (values["source"] || "fr").toLowerCase()
const TOLS = [0.1, 0.5, 5] as const // rooftop / street / locality (km)
const GATE_TOL = 5 // the z-test runs at the locality bucket (the dominant resolvable tier)

interface Sample {
	query: string
	lat: number
	lon: number
}

/**
 * Held-out truth sources — fresh-draw, NOT in mailwoman's training corpus, so they measure generalization. Each parses
 * a semicolon row of its staging file into a BARE-form query (no postcode — the hard case the tail exercises) + truth
 * coord. FR/BAN streams the 5 GB file; the smaller pools (US/FDIC, ~77k) are the fast draw. Add a source by dropping a
 * staging file + a parser here.
 */
interface SourceDef {
	file: string
	label: string
	parse(cols: string[]): Sample | null
}
const SOURCES: Record<string, SourceDef> = {
	fr: {
		file: `${mailwomanDataRoot()}/corpus/staging/ban-france.csv`,
		label: "FR/BAN",
		// BAN columns: numero(2) nom_voie(4) nom_commune(7) lon(12) lat(13)
		parse(c) {
			const voie = (c[4] ?? "").trim()
			const numero = (c[2] ?? "").trim()
			const commune = (c[7] ?? "").trim()
			const lat = Number(c[13])
			const lon = Number(c[12])

			if (!voie || !numero || !commune || !voie.includes(" ") || !Number.isFinite(lat) || !Number.isFinite(lon))
				return null

			return { query: `${numero} ${voie}, ${commune}`, lat, lon }
		},
	},
	us: {
		file: `${mailwomanDataRoot()}/corpus/staging/fdic-us.csv`,
		label: "US/FDIC",
		// fdic-us.csv columns: address(0) city(1) state(2) zip(3) lat(4) lon(5)
		parse(c) {
			const address = (c[0] ?? "").trim()
			const city = (c[1] ?? "").trim()
			const state = (c[2] ?? "").trim()
			const lat = Number(c[4])
			const lon = Number(c[5])

			if (!address || !city || !state || !Number.isFinite(lat) || !Number.isFinite(lon)) return null

			return { query: `${address}, ${city}, ${state}`, lat, lon }
		},
	},
}
const selected = SOURCES[SOURCE]

if (!selected) {
	console.error(`Unknown --source "${SOURCE}". Known: ${Object.keys(SOURCES).join(", ")}`)
	process.exit(2)
}
const src: SourceDef = selected // typed so the draw() closure doesn't re-widen it to possibly-undefined

/** Reservoir-sample N rows with truth coords from the selected source — a genuinely fresh draw each run. */
async function draw(n: number): Promise<Sample[]> {
	const rl = createInterface({ input: createReadStream(src.file, { encoding: "utf8" }), crlfDelay: Infinity })
	const res: Sample[] = []
	let seen = 0
	let line = 0

	for await (const raw of rl) {
		if (line++ === 0) continue // header
		const s = src.parse(raw.split(";"))

		if (!s) continue
		seen++

		if (res.length < n) {
			res.push(s)
		} else {
			const j = Math.floor(Math.random() * seen)

			if (j < n) {
				res[j] = s
			}
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
			if (km <= t) {
				hits[i] = (hits[i] ?? 0) + 1
			}
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
console.error(`[gauntlet/holdout] drawing ${N} fresh ${src.label} addresses…`)
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

console.log(`\n=== Gauntlet · held-out fresh draw (${src.label}, n=${n}) ===`)
console.log(`  tolerance     production   candidate`)
TOLS.forEach((t, i) => {
	console.log(
		`  ≤${String(t).padEnd(5)}km   ${String(prod.hits[i]).padStart(8)}     ${String(cand.hits[i]).padStart(8)}`
	)
})
console.log(`  resolved      ${String(prod.resolved).padStart(8)}     ${String(cand.resolved).padStart(8)}`)
console.log(`\n  z (candidate − production) @ ≤${GATE_TOL}km: ${z.toFixed(2)}`)
// Block ONLY on a significant regression. Candidate ahead or within noise → pass.
const pass = z >= -1.96
console.log(
	`  verdict: ${pass ? "PASS (candidate not significantly worse)" : "FAIL (candidate significantly worse — do not ship)"}`
)
process.exit(pass ? 0 : 1)
