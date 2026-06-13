/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   National ADDRESS-POINT (situs) shard build driver. The situs counterpart to
 *   `build-national-interpolation.mjs` — but simpler: there are no downloads. Every US address point
 *   already lives in one pinned Overture parquet
 *   (`/mnt/playpen/mailwoman-data/overture/<release>/addresses-us.parquet`), so this just drives the
 *   per-state `build-address-point-shard.ts` across every state that has coverage, sequentially (one
 *   DuckDB parquet reader + one SQLite writer at a time — parallelism would thrash the 6.5GB parquet
 *   and the disk for no wall-clock win; the bottleneck is the per-row SQLite insert, not CPU).
 *
 *   LICENSING (measured 2026-06-14, see docs/articles/evals/2026-06-14-reconcile-retirement.md's
 *   sibling note + the campaign doc): US Overture addresses are NAD (68%, US public domain) +
 *   OpenAddresses (32%, government open data) with ZERO OpenStreetMap/ODbL rows. So the default is NO
 *   license filter — applying `--license-filter NAD` would drop 39.4M OpenAddresses points (a third of
 *   coverage, the dense urban counties) for no licensing benefit. The only obligation is ATTRIBUTION:
 *   the per-row `overture:<dataset>` provenance the builder stamps is summarized into
 *   `<out-dir>/ATTRIBUTION.json` here. Pass `--license-filter <datasets>` only to build a
 *   deliberately-narrowed shard.
 *
 *   Idempotency: a state whose output DB already exists is skipped unless `--force`.
 *   Population/coverage-ranked order (largest first) so killing early still yields the most points.
 *
 *   Usage:
 *     node scripts/build-national-situs.mjs [--out-dir <path>] [--release <tag>]
 *       [--states CA,FL,...] [--license-filter NAD] [--force]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
	options: {
		"out-dir": { type: "string", default: "/mnt/playpen/mailwoman-data/address-points" },
		release: { type: "string", default: "2026-05-20.0" },
		states: { type: "string" },
		"license-filter": { type: "string" },
		force: { type: "boolean", default: false },
	},
})

// Coverage-ranked (largest first, from the 2026-05-20.0 parquet probe). NH + HI carry zero Overture
// address coverage in this release, so they're absent — interpolation-only states. VI (territory)
// included for completeness; harmless if the parser's region→slug map skips it.
const STATES_BY_COVERAGE = [
	"CA", "FL", "TX", "NY", "NC", "OH", "IL", "TN", "OR", "VA", "NJ", "AZ", "MA", "IN", "WA", "AL",
	"MD", "CO", "KY", "MN", "AR", "MO", "IA", "WI", "OK", "UT", "CT", "MS", "PA", "NM", "WV", "KS",
	"NE", "MI", "ME", "GA", "MT", "DE", "ND", "DC", "RI", "ID", "VT", "AK", "LA", "WY", "SC", "SD",
	"NV", "VI",
]

const states = (args.states ? args.states.split(",").map((s) => s.trim().toUpperCase()) : STATES_BY_COVERAGE).filter(Boolean)
const outDir = args["out-dir"]
mkdirSync(outDir, { recursive: true })

const builder = path.resolve(import.meta.dirname, "build-address-point-shard.ts")
const t0 = Date.now()
const manifest = { release: args.release, builtAt: null, licenseFilter: args["license-filter"] ?? null, states: {}, datasetTotals: {} }
let built = 0, skipped = 0, failed = 0, totalRows = 0

for (const state of states) {
	const dbPath = path.join(outDir, `address-points-us-${state.toLowerCase()}.db`)
	if (existsSync(dbPath) && !args.force) {
		console.log(`[skip] ${state} — ${path.basename(dbPath)} exists (use --force to rebuild)`)
		skipped++
		continue
	}
	const argv = ["--experimental-strip-types", builder, "--state", state, "--release", args.release, "--out", dbPath]
	if (args["license-filter"]) argv.push("--license-filter", args["license-filter"])
	const tState = Date.now()
	const res = spawnSync("node", argv, { encoding: "utf8" })
	const secs = ((Date.now() - tState) / 1000).toFixed(1)
	if (res.status !== 0) {
		console.error(`[FAIL] ${state} (${secs}s)\n${res.stderr?.slice(-600) ?? ""}`)
		manifest.states[state] = { ok: false }
		failed++
		continue
	}
	// Parse the builder's stdout: "<n> points → ..." and the per-dataset provenance lines.
	const out = res.stdout
	const pts = Number(out.match(/^(\d+) points →/m)?.[1] ?? 0)
	const datasets = {}
	for (const m of out.matchAll(/^ {2}overture:(\S+)\s+([\d,]+) rows$/gm)) {
		const ds = m[1], n = Number(m[2].replace(/,/g, ""))
		datasets[ds] = n
		manifest.datasetTotals[ds] = (manifest.datasetTotals[ds] ?? 0) + n
	}
	manifest.states[state] = { ok: true, points: pts, seconds: Number(secs), datasets }
	totalRows += pts
	built++
	console.log(`[ok]   ${state} — ${pts.toLocaleString()} points (${secs}s) → ${path.basename(dbPath)}`)
	// Persist the manifest after every state so a kill leaves a usable partial.
	manifest.builtAt = new Date(t0).toISOString().slice(0, 10)
	writeFileSync(path.join(outDir, "ATTRIBUTION.json"), JSON.stringify(manifest, null, 2))
}

const mins = ((Date.now() - t0) / 60000).toFixed(1)
console.log(`\n=== national situs build complete ===`)
console.log(`built ${built} · skipped ${skipped} · failed ${failed} · ${totalRows.toLocaleString()} total points · ${mins} min`)
console.log(`dataset families:`)
for (const [ds, n] of Object.entries(manifest.datasetTotals).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
	console.log(`  ${ds.padEnd(28)} ${n.toLocaleString()}`)
}
console.log(`attribution manifest → ${path.join(outDir, "ATTRIBUTION.json")}`)
