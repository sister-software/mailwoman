/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   National ADDRESS-POINT (situs) shard build driver. The situs counterpart to
 *   `build-national-interpolation.mjs` — but downloadless: every US address point already lives in
 *   one pinned Overture parquet, so this drives the per-state `build-address-point-shard.ts` across
 *   every covered state.
 *
 *   PARALLELISM: states build concurrently via spliterator's `asyncParallelIterator` (the house
 *   bounded-concurrency primitive — same one `build-unified-wof.ts` uses to fan out file reads behind
 *   a single writer). Each state is an isolated child process (its own DuckDB + SQLite heap), so N
 *   states run at once with no shared-memory risk. To avoid oversubscribing cores, each child's DuckDB
 *   scan is capped at `--threads` (default: cores / concurrency), so concurrency × threads ≈ cores.
 *   The per-state steady-state bottleneck is the single-threaded SQLite insert loop, not the scan, so
 *   N concurrent inserts is the real win. Sequentialising is still available via `--concurrency 1`.
 *
 *   LICENSING (measured 2026-06-14): US Overture addresses are NAD (68%, US public domain) +
 *   OpenAddresses (32%, government open data) with ZERO OpenStreetMap/ODbL rows. So the default is NO
 *   license filter — `--license-filter NAD` would drop a third of coverage for no benefit. The only
 *   obligation is ATTRIBUTION: the per-row `overture:<dataset>` provenance is summarized into
 *   `<out-dir>/ATTRIBUTION.json`. Pass `--license-filter <datasets>` to build a narrowed shard.
 *
 *   IDEMPOTENCY: a state is skipped only if its shard is COMPLETE — non-empty `address_point` table
 *   AND the `idx_ap_streetkey` index present. A half-built shard (data inserted, indexing/VACUUM not
 *   reached — e.g. a killed run) is detected as incomplete and rebuilt. `--force` rebuilds regardless.
 *
 *   Usage:
 *     node scripts/build-national-situs.mjs [--out-dir <path>] [--release <tag>]
 *       [--states CA,FL,...] [--concurrency 4] [--threads N] [--license-filter NAD] [--force]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import * as os from "node:os"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { asyncParallelIterator } from "spliterator"

const { values: args } = parseArgs({
	options: {
		"out-dir": { type: "string", default: "/mnt/playpen/mailwoman-data/address-points" },
		release: { type: "string", default: "2026-05-20.0" },
		states: { type: "string" },
		"license-filter": { type: "string" },
		concurrency: { type: "string", default: "4" },
		threads: { type: "string" },
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

const concurrency = Math.max(1, parseInt(args.concurrency, 10) || 4)
const cores = os.availableParallelism?.() ?? os.cpus().length
const threads = Math.max(1, parseInt(args.threads ?? "", 10) || Math.floor(cores / concurrency))
const builder = path.resolve(import.meta.dirname, "build-address-point-shard.ts")

console.log(`national situs build — ${states.length} states, concurrency=${concurrency}, ${threads} DuckDB threads/state (of ${cores} cores)`)

// A shard is COMPLETE iff its address_point table has rows AND the streetkey index exists — the index
// is the last build step, so its presence means insert + index + VACUUM all finished.
function isComplete(dbPath) {
	if (!existsSync(dbPath)) return false
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true })
		const n = db.prepare("SELECT count(*) AS n FROM address_point").get().n
		const idx = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_ap_streetkey'").get().n
		db.close()
		return n > 0 && idx > 0
	} catch {
		return false
	}
}

function buildOneState(state) {
	const dbPath = path.join(outDir, `address-points-us-${state.toLowerCase()}.db`)
	if (!args.force && isComplete(dbPath)) return Promise.resolve({ state, skipped: true })
	return new Promise((resolve) => {
		const argv = [
			"--experimental-strip-types", builder,
			"--state", state, "--release", args.release, "--out", dbPath, "--threads", String(threads),
		]
		if (args["license-filter"]) argv.push("--license-filter", args["license-filter"])
		const t = Date.now()
		const child = spawn("node", argv)
		let out = "", err = ""
		child.stdout.on("data", (d) => (out += d))
		child.stderr.on("data", (d) => (err += d))
		child.on("close", (code) => resolve({ state, code, seconds: Number(((Date.now() - t) / 1000).toFixed(1)), out, err }))
	})
}

const t0 = Date.now()
const manifest = { release: args.release, builtAt: null, licenseFilter: args["license-filter"] ?? null, states: {}, datasetTotals: {} }
let built = 0, skipped = 0, failed = 0, totalRows = 0

// asyncParallelIterator yields results AS THEY COMPLETE (out of order), capped at `concurrency` in
// flight. Each result carries its own state, so out-of-order is fine for the state-keyed manifest.
for await (const r of asyncParallelIterator(states, concurrency, buildOneState)) {
	if (r.skipped) {
		console.log(`[skip] ${r.state} — complete (use --force to rebuild)`)
		skipped++
		continue
	}
	if (r.code !== 0) {
		console.error(`[FAIL] ${r.state} (${r.seconds}s)\n${(r.err || "").slice(-600)}`)
		manifest.states[r.state] = { ok: false }
		failed++
		continue
	}
	const pts = Number(r.out.match(/^(\d+) points →/m)?.[1] ?? 0)
	const datasets = {}
	for (const m of r.out.matchAll(/^ {2}overture:(\S+)\s+([\d,]+) rows$/gm)) {
		const ds = m[1], n = Number(m[2].replace(/,/g, ""))
		datasets[ds] = n
		manifest.datasetTotals[ds] = (manifest.datasetTotals[ds] ?? 0) + n
	}
	manifest.states[r.state] = { ok: true, points: pts, seconds: r.seconds, datasets }
	totalRows += pts
	built++
	console.log(`[ok]   ${r.state} — ${pts.toLocaleString()} points (${r.seconds}s)`)
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
