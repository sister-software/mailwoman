/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Honest eval for the house-number interpolation tier (#483) at street grain: hold out a
 *   deterministic sample of REAL address points (the #476 shard — Overture/NAD situs coordinates,
 *   an independent lineage from the TIGER segment table), query each point's `(street, number,
 *   postcode)` through `StreetInterpolator`, and report coordinate error vs truth plus coverage.
 *   Self-reporting; grades per the #483 banded gate ruling (2026-06-12).
 *
 *   Sampling is hash-ordered (seeded, no RNG) over DISTINCT (street, number, postcode) keys with
 *   strictly-numeric house numbers — the only inputs the tier models (the non-numeric share is
 *   reported, not hidden).
 *
 *   Two modes:
 *
 *   - `--mode tiger` (default): the TIGER pilot's eval, unchanged — `StreetInterpolator` alone, gate
 *       graded on all hits.
 *   - `--mode ladder`: Method 2 (`AddressPointInterpolator` over the SAME #476 shard that supplies the
 *       gold) with the TIGER tier as fall-through, reported per method/bracket stratum.
 *       Non-circular by construction: the lookup excludes every row at the queried house number, so
 *       a held-out key is only ever interpolated from non-held-out neighbor numbers (in production
 *       the exact tier owns on-file numbers anyway). The TIGER-only result on the same sample is
 *       reported alongside for the coverage shift.
 *
 *   # Banded gate — #483 operator ruling 2026-06-12 (stated re-baseline, recorded)
 *
 *   Rows are graded WITHIN their claimed `uncertaintyM` band. The gate thresholds scale with the band
 *   ceiling C:
 *
 *   Band ≤ 100 m → p50 ≤ 50 m, p90 ≤ 150 m (C = 100: p50 ≤ C/2, p90 ≤ 1.5 × C) band ≤ 250 m → p50 ≤
 *   125 m, p90 ≤ 375 m (C = 250: p50 ≤ C/2, p90 ≤ 1.5 × C) band ≤ 500 m → p50 ≤ 250 m, p90 ≤ 750 m
 *   (C = 500: p50 ≤ C/2, p90 ≤ 1.5 × C) band > 500 m → no gate cap — priced honestly
 *
 *   Formula: gate_p50 = C / 2, gate_p90 = 1.5 × C, where C is the band ceiling. The ≤ 100 m band is
 *   the explicit Phase 1 gate from the pre-registered VT pilot. Wider bands are graded on
 *   calibrated claims: a row claiming 300 m uncertainty falls in the ≤ 500 m band (C = 500) and is
 *   expected to measure ≤ 250 m / ≤ 750 m. Bands with zero rows are flagged, not silently omitted.
 *   A miss is a finding reported plainly — the band ceiling is NEVER moved to make a row pass.
 *
 *   NOTE: imports the WORKTREE's compiled module by relative path (run `yarn compile` first) — the
 *   bare `@mailwoman/resolver-wof-sqlite` specifier would resolve through the parent checkout's
 *   node_modules to a build without this module.
 *
 *   Usage: yarn compile && node scripts/eval/interpolation-eval.ts\
 *   [--points $MAILWOMAN_DATA_ROOT/address-points/address-points-us-vt.db]\
 *   [--segments $MAILWOMAN_DATA_ROOT/interpolation/interpolation-us-vt.db]\
 *   [--mode tiger|ladder] [--sample 5000] [--seed 42]
 */

import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"

import { AddressPointInterpolator } from "../../resolver-wof-sqlite/out/address-point-interpolation.js"
import { haversineKm } from "../../resolver-wof-sqlite/out/geo.js"
import { StreetInterpolator } from "../../resolver-wof-sqlite/out/interpolation.js"

const { values: args } = parseArgs({
	options: {
		points: {
			type: "string",
			default: dataRootPath("address-points", "address-points-us-vt.db"),
		},
		segments: {
			type: "string",
			default: dataRootPath("interpolation", "interpolation-us-vt.db"),
		},
		mode: { type: "string", default: "tiger" },
		sample: { type: "string", default: "5000" },
		seed: { type: "string", default: "42" },
	},
})
const SAMPLE = Number(args.sample)
const MODE = args.mode as "tiger" | "ladder"

if (MODE !== "tiger" && MODE !== "ladder") {
	console.error(`--mode must be tiger or ladder, got ${String(args.mode)}`)
	process.exit(1)
}

/**
 * Banded gate definition — #483 operator ruling 2026-06-12.
 *
 * Formula: gate_p50 = C / 2, gate_p90 = 1.5 × C, where C is the band ceiling in metres. The open-ended top band (> 500
 * m) carries no gate cap — those rows are reported honestly.
 */
interface BandDef {
	/** Label shown in output. */
	label: string
	/** Upper bound for `uncertaintyM` (inclusive); null = unbounded (no gate). */
	ceiling: number | null
	/** Gate p50 threshold (metres); derived from ceiling via C/2. Null = no gate. */
	gateP50: number | null
	/** Gate p90 threshold (metres); derived from ceiling via 1.5×C. Null = no gate. */
	gateP90: number | null
}

/**
 * The four uncertainty bands. Each row's `uncertaintyM` is assigned to the FIRST band whose ceiling
 *
 * > = uncertaintyM (or the unbounded tail). Gate thresholds follow the ruling formula.
 */
const BANDS: BandDef[] = [
	{ label: "≤ 100 m", ceiling: 100, gateP50: 50, gateP90: 150 },
	{ label: "≤ 250 m", ceiling: 250, gateP50: 125, gateP90: 375 },
	{ label: "≤ 500 m", ceiling: 500, gateP50: 250, gateP90: 750 },
	{ label: "> 500 m (no gate cap — priced honestly)", ceiling: null, gateP50: null, gateP90: null },
]

function assignBand(uncertaintyM: number): BandDef {
	for (const band of BANDS) {
		if (band.ceiling === null || uncertaintyM <= band.ceiling) return band
	}

	return BANDS[BANDS.length - 1]!
}

const points = new DatabaseSync(args.points!, { readOnly: true })

// Eligibility: numeric house number + a postcode to scope by. Report the excluded share —
// the tier's modeling boundary, not an eval trick.
const totals = points
	.prepare(
		`SELECT count(*) AS all_rows,
			count(*) FILTER (WHERE number NOT GLOB '[0-9]*' OR number GLOB '*[^0-9]*') AS non_numeric,
			count(*) FILTER (WHERE postcode IS NULL OR postcode = '') AS no_postcode
		 FROM address_point`
	)
	.get() as { all_rows: number; non_numeric: number; no_postcode: number }

interface GoldRow {
	street_raw: string
	number: string
	postcode: string
	lat: number
	lon: number
}

// Deterministic hash-ordered sample over distinct query keys (duplicate situs points — unit
// siblings — collapse to one query; truth = the centroid of the duplicates' coordinates).
// Hash order is JS-side md5 (SQLite ships no hash builtin) — seeded, no RNG.
const eligible = points
	.prepare(
		`SELECT street_norm, street_raw, number, postcode, avg(lat) AS lat, avg(lon) AS lon
		 FROM address_point
		 WHERE number GLOB '[0-9]*' AND number NOT GLOB '*[^0-9]*'
			AND postcode IS NOT NULL AND postcode != ''
		 GROUP BY street_norm, number, postcode`
	)
	.all() as unknown as (GoldRow & { street_norm: string })[]
points.close()
const hashOf = (r: GoldRow & { street_norm: string }) =>
	createHash("md5").update(`${r.street_norm}|${r.number}|${r.postcode}|${args.seed}`).digest("hex")
const gold: GoldRow[] = eligible
	.map((r) => ({ row: r, h: hashOf(r) }))
	.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
	.slice(0, SAMPLE)
	.map((x) => x.row)

const interpolator = new StreetInterpolator({ dbPath: args.segments! })
// Ladder mode: Method 2 over the gold shard itself (self-number exclusion makes that
// non-circular — see module doc), TIGER as the fall-through.
const ladder = MODE === "ladder" ? new AddressPointInterpolator({ dbPath: args.points!, fallback: interpolator }) : null

interface Outcome {
	errorM: number
	parityMatched?: boolean
	uncertaintyM: number
	method: "address_point" | "tiger_range"
	bracket?: "both" | "single"
}

const hits: Outcome[] = []
// Ladder mode also runs the TIGER tier alone on the same sample — the coverage/error shift.
const tigerAlone: number[] = []
let misses = 0

for (const row of gold) {
	const query = { street: row.street_raw, number: row.number, postcode: row.postcode }
	const hit = (ladder ?? interpolator).find(query)

	if (hit) {
		hits.push({
			errorM: haversineKm(row.lat, row.lon, hit.lat, hit.lon) * 1000,
			parityMatched: hit.parityMatched,
			uncertaintyM: hit.uncertaintyM,
			method: hit.method,
			bracket: hit.bracket,
		})
	} else {
		misses++
	}

	if (ladder) {
		const tigerHit = interpolator.find(query)

		if (tigerHit) {
			tigerAlone.push(haversineKm(row.lat, row.lon, tigerHit.lat, tigerHit.lon) * 1000)
		}
	}
}
ladder?.close()
interpolator.close()

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)

	return sorted[Math.max(0, idx)]!
}

function report(label: string, outcomes: Outcome[]): void {
	const errors = outcomes
		.map((o) => o.errorM)
		.slice()
		.sort((a, b) => a - b)

	if (errors.length === 0) {
		console.log(`  ${label}: 0 rows`)

		return
	}
	const fmt = (v: number) => `${Math.round(v)}m`
	console.log(
		`  ${label}: n=${errors.length} · p50 ${fmt(percentile(errors, 50))} · p90 ${fmt(percentile(errors, 90))} · p99 ${fmt(percentile(errors, 99))} · max ${fmt(errors[errors.length - 1]!)}`
	)
}

const queried = gold.length
const coverage = queried === 0 ? 0 : hits.length / queried
const within = (m: number) => hits.filter((h) => h.errorM <= m).length / Math.max(1, hits.length)

console.log(`interpolation eval (mode: ${MODE}) — segments: ${args.segments}`)
console.log(`gold: ${args.points}`)
console.log(
	`eligibility: ${totals.all_rows} points · ${totals.non_numeric} non-numeric number (${((100 * totals.non_numeric) / totals.all_rows).toFixed(1)}%) · ${totals.no_postcode} without postcode (${((100 * totals.no_postcode) / totals.all_rows).toFixed(1)}%)`
)
console.log(`sampled ${queried} distinct (street, number, postcode) keys (seed ${args.seed})`)
console.log("")
console.log(`coverage: ${hits.length}/${queried} answered (${(100 * coverage).toFixed(1)}%)`)
console.log(`coord error vs truth (haversine):`)
report("all hits", hits)

if (MODE === "ladder") {
	const both = hits.filter((h) => h.method === "address_point" && h.bracket === "both")
	const single = hits.filter((h) => h.method === "address_point" && h.bracket === "single")
	const tigerFallback = hits.filter((h) => h.method === "tiger_range")
	report("method 2 — bracketed (both-sided)", both)
	report("method 2 — single-sided extrapolation", single)
	report("tiger_range fallback", tigerFallback)
	const tigerSorted = tigerAlone.slice().sort((a, b) => a - b)
	console.log(
		`  tiger-alone on this sample (the shift baseline): coverage ${((100 * tigerAlone.length) / Math.max(1, queried)).toFixed(1)}% · p50 ${Math.round(percentile(tigerSorted, 50))}m · p90 ${Math.round(percentile(tigerSorted, 90))}m`
	)
} else {
	report(
		"parity-matched",
		hits.filter((h) => h.parityMatched)
	)
	report(
		"opposite-side fallback",
		hits.filter((h) => !h.parityMatched)
	)
}
console.log(
	`within: ≤50m ${(100 * within(50)).toFixed(1)}% · ≤100m ${(100 * within(100)).toFixed(1)}% · ≤500m ${(100 * within(500)).toFixed(1)}% · ≤1km ${(100 * within(1000)).toFixed(1)}%`
)
const medianUncertainty = percentile(
	hits
		.map((h) => h.uncertaintyM)
		.slice()
		.sort((a, b) => a - b),
	50
)
console.log(`claimed uncertainty: median ${Math.round(medianUncertainty)}m`)
console.log("")

// ── Banded gate — #483 operator ruling 2026-06-12 ──────────────────────────────────────────────
//
// Formula: gate_p50 = C / 2, gate_p90 = 1.5 × C, where C is the band ceiling in metres.
// Rows are grouped by their claimed `uncertaintyM`; each band is graded independently.
// The open-ended top band (> 500 m) carries no gate — those claims are priced honestly.
// Bands with zero rows are flagged; a miss is reported plainly, never papered over.
//
console.log("banded gate (#483 ruling 2026-06-12) — formula: gate_p50 = C/2, gate_p90 = 1.5×C")
console.log("  bands by claimed uncertaintyM | gate thresholds | measured p50 / p90 | verdict")

let allBandedPass = true

for (const band of BANDS) {
	const bandHits = hits.filter((h) => assignBand(h.uncertaintyM) === band)
	const errors = bandHits
		.map((h) => h.errorM)
		.slice()
		.sort((a, b) => a - b)

	if (errors.length === 0) {
		console.log(`  ${band.label}: 0 rows — FLAG: no rows in this band`)

		// An empty gated band is not a pass — it means we have no data to grade.
		if (band.gateP50 !== null) {
			allBandedPass = false
		}
		continue
	}

	const p50 = percentile(errors, 50)
	const p90 = percentile(errors, 90)
	const fmt = (v: number) => `${Math.round(v)}m`

	if (band.gateP50 === null || band.gateP90 === null) {
		// Unbounded band: report measurements, no PASS/MISS verdict.
		console.log(
			`  ${band.label}: n=${errors.length} · p50 ${fmt(p50)} · p90 ${fmt(p90)} (no gate cap — reported honestly)`
		)
	} else {
		const p50Pass = p50 <= band.gateP50
		const p90Pass = p90 <= band.gateP90
		const verdict = p50Pass && p90Pass ? "PASS" : "MISS"

		if (!p50Pass || !p90Pass) {
			allBandedPass = false
		}
		console.log(
			`  ${band.label}: n=${errors.length} · gate p50 ≤ ${fmt(band.gateP50)} → ${fmt(p50)} ${p50Pass ? "PASS" : "MISS"} · gate p90 ≤ ${fmt(band.gateP90)} → ${fmt(p90)} ${p90Pass ? "PASS" : "MISS"} · band ${verdict}`
		)
	}
}

console.log("")
process.exitCode = allBandedPass ? 0 : 1
