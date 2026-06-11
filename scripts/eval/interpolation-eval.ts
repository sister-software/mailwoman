/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Honest eval for the house-number interpolation tier (#483) at street grain: hold out a
 *   deterministic sample of REAL address points (the #476 shard — Overture/NAD situs coordinates,
 *   an independent lineage from the TIGER segment table), query each point's `(street, number,
 *   postcode)` through `StreetInterpolator`, and report coordinate error vs truth plus coverage.
 *   Self-reporting; grades against the #483 pre-registered gate (p50 ≤ 50 m, p90 ≤ 150 m on the VT
 *   holdout).
 *
 *   Sampling is hash-ordered (seeded, no RNG) over DISTINCT (street, number, postcode) keys with
 *   strictly-numeric house numbers — the only inputs the tier models (the non-numeric share is
 *   reported, not hidden).
 *
 *   NOTE: imports the WORKTREE's compiled module by relative path (run `yarn compile` first) — the
 *   bare `@mailwoman/resolver-wof-sqlite` specifier would resolve through the parent checkout's
 *   node_modules to a build without this module.
 *
 *   Usage: yarn compile && node scripts/eval/interpolation-eval.ts\
 *   [--points /mnt/playpen/mailwoman-data/address-points/address-points-us-vt.db]\
 *   [--segments /mnt/playpen/mailwoman-data/interpolation/interpolation-us-vt.db]\
 *   [--sample 5000] [--seed 42]
 */

import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { haversineKm } from "../../resolver-wof-sqlite/out/geo.js"
import { StreetInterpolator } from "../../resolver-wof-sqlite/out/interpolation.js"

const { values: args } = parseArgs({
	options: {
		points: {
			type: "string",
			default: "/mnt/playpen/mailwoman-data/address-points/address-points-us-vt.db",
		},
		segments: {
			type: "string",
			default: "/mnt/playpen/mailwoman-data/interpolation/interpolation-us-vt.db",
		},
		sample: { type: "string", default: "5000" },
		seed: { type: "string", default: "42" },
	},
})
const SAMPLE = Number(args.sample)

// Pre-registered gate from the #483 issue — restated, never silently relaxed.
const GATE_P50_M = 50
const GATE_P90_M = 150

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

interface Outcome {
	errorM: number
	parityMatched: boolean
	uncertaintyM: number
}

const hits: Outcome[] = []
let misses = 0
for (const row of gold) {
	const hit = interpolator.find({ street: row.street_raw, number: row.number, postcode: row.postcode })
	if (!hit) {
		misses++
		continue
	}
	hits.push({
		errorM: haversineKm(row.lat, row.lon, hit.lat, hit.lon) * 1000,
		parityMatched: hit.parityMatched,
		uncertaintyM: hit.uncertaintyM,
	})
}
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
const parityHits = hits.filter((h) => h.parityMatched)
const fallbackHits = hits.filter((h) => !h.parityMatched)
const allErrors = hits
	.map((h) => h.errorM)
	.slice()
	.sort((a, b) => a - b)
const p50 = percentile(allErrors, 50)
const p90 = percentile(allErrors, 90)
const within = (m: number) => hits.filter((h) => h.errorM <= m).length / Math.max(1, hits.length)

console.log(`interpolation eval — segments: ${args.segments}`)
console.log(`gold: ${args.points}`)
console.log(
	`eligibility: ${totals.all_rows} points · ${totals.non_numeric} non-numeric number (${((100 * totals.non_numeric) / totals.all_rows).toFixed(1)}%) · ${totals.no_postcode} without postcode (${((100 * totals.no_postcode) / totals.all_rows).toFixed(1)}%)`
)
console.log(`sampled ${queried} distinct (street, number, postcode) keys (seed ${args.seed})`)
console.log("")
console.log(`coverage: ${hits.length}/${queried} found a segment (${(100 * coverage).toFixed(1)}%)`)
console.log(`coord error vs truth (haversine):`)
report("all hits", hits)
report("parity-matched", parityHits)
report("opposite-side fallback", fallbackHits)
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
console.log(`claimed uncertainty (half segment length): median ${Math.round(medianUncertainty)}m`)
console.log("")
const p50Pass = p50 <= GATE_P50_M
const p90Pass = p90 <= GATE_P90_M
console.log(
	`gate (#483 pre-registered): p50 ≤ ${GATE_P50_M}m → ${Math.round(p50)}m ${p50Pass ? "PASS" : "MISS"} · p90 ≤ ${GATE_P90_M}m → ${Math.round(p90)}m ${p90Pass ? "PASS" : "MISS"}`
)
process.exitCode = p50Pass && p90Pass ? 0 : 1
