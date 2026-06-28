/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Split-conformal coordinate intervals over resolved localities (#374, resolved-coordinate
 *   variant).
 *
 *   Beyond the ECE point-calibration shipped in #59, this gives a coverage GUARANTEE on WHERE the
 *   address is: a radius R(α) around the resolved locality centroid that contains the true point
 *   with marginal probability ≥ 1−α. Split conformal, no distributional assumption — the only
 *   inputs are per-row nonconformity scores (Haversine from the gold point to the resolved
 *   centroid) and a held-out split.
 *
 *   Method (split conformal regression):
 *
 *   1. Nonconformity score sᵢ = haversine(gold, resolved_centroid) for every RESOLVED row.
 *   2. Split scores into calibration / test (seeded).
 *   3. For level α: R(α) = the ⌈(1−α)(n_cal+1)⌉-th smallest calibration score (the conformal quantile;
 *        guarantees marginal coverage ≥ 1−α). If that rank exceeds n_cal, R = ∞ (can't guarantee at
 *        this α).
 *   4. Realized coverage = fraction of TEST scores ≤ R(α) — should land near 1−α.
 *
 *   Ported faithfully from scripts/eval/conformal-coord.py. SQLite reads go through `node:sqlite`.
 *
 *   Usage: node --experimental-strip-types scripts/eval/conformal-coord.ts --dump
 *   /tmp/resolved-de-v094.json --label DE [--out-json …] node --experimental-strip-types
 *   scripts/eval/conformal-coord.ts --self-test
 */

import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

const DEFAULT_DB = "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const r = 6371.0
	const p = Math.PI / 180.0
	const dlat = (lat2 - lat1) * p
	const dlon = (lon2 - lon1) * p
	const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dlon / 2) ** 2
	return 2 * r * Math.asin(Math.sqrt(a))
}

/** The ⌈(1−α)(n+1)⌉-th smallest calibration score. Infinity when the rank exceeds n (α too small). */
function conformalRadius(calScores: number[], alpha: number): number {
	const n = calScores.length
	if (n === 0) return Infinity
	const rank = Math.ceil((1 - alpha) * (n + 1))
	if (rank > n) return Infinity
	return [...calScores].sort((a, b) => a - b)[rank - 1]!
}

interface IntervalRow {
	alpha: number
	target_coverage: number
	radius_km: number
	realized_coverage: number
	n_cal: number
	n_test: number
}

/** Deterministic shuffle (seeded LCG, no numpy needed), split, conformal radius + realized coverage. */
function evaluate(scores: number[], alphas: number[], seed: number, calFrac: number): IntervalRow[] {
	const idx = Array.from({ length: scores.length }, (_, i) => i)
	// Tiny seeded LCG shuffle — keeps the split reproducible without importing numpy/random-as-global.
	// BigInt mirrors Python's arbitrary-precision ints: the products overflow 2^53, so Number would drift.
	let state = (BigInt(seed) * 2654435761n + 1n) & 0xffffffffn
	for (let i = idx.length - 1; i > 0; i--) {
		state = (state * 1103515245n + 12345n) & 0x7fffffffn
		const j = Number(state % BigInt(i + 1))
		;[idx[i], idx[j]] = [idx[j]!, idx[i]!]
	}
	const shuffled = idx.map((i) => scores[i]!)
	const nCal = Math.trunc(shuffled.length * calFrac)
	const cal = shuffled.slice(0, nCal)
	const test = shuffled.slice(nCal)
	const rows: IntervalRow[] = []
	for (const a of alphas) {
		const r = conformalRadius(cal, a)
		const cov = test.length ? test.filter((s) => s <= r).length / test.length : NaN
		rows.push({
			alpha: a,
			target_coverage: 1 - a,
			radius_km: r,
			realized_coverage: cov,
			n_cal: cal.length,
			n_test: test.length,
		})
	}
	return rows
}

interface ResolvedRow {
	neuralLocId?: number | null
	lat?: number | null
	lon?: number | null
}

/**
 * Per resolved row: haversine(gold, resolved-locality centroid). Returns [scores, nTotal,
 * nAbstain].
 */
function loadScores(dumpPath: string, dbPath: string): [number[], number, number] {
	const data = JSON.parse(readFileSync(dumpPath, "utf-8"))
	const rows: ResolvedRow[] = Array.isArray(data) ? data : (data.resolved ?? data.rows ?? [])
	const db = new DatabaseSync(dbPath, { readOnly: true })
	const stmt = db.prepare("SELECT latitude, longitude FROM spr WHERE id = ?")
	const centroidCache = new Map<number, [number | null, number | null] | undefined>()

	function centroid(pid: number): [number | null, number | null] | undefined {
		if (!centroidCache.has(pid)) {
			const row = stmt.get(pid) as { latitude: number | null; longitude: number | null } | undefined
			centroidCache.set(pid, row ? [row.latitude, row.longitude] : undefined)
		}
		return centroidCache.get(pid)
	}

	const scores: number[] = []
	let nAbstain = 0
	for (const r of rows) {
		const pid = r.neuralLocId
		if (pid === null || pid === undefined) {
			nAbstain += 1
			continue
		}
		const c = centroid(pid)
		if (!c || c[0] === null || r.lat === null || r.lat === undefined) {
			nAbstain += 1
			continue
		}
		scores.push(haversineKm(r.lat!, r.lon!, c[0]!, c[1]!))
	}
	db.close()
	return [scores, rows.length, nAbstain]
}

/** Python `f"{x:>{w}.{p}f}"` — fixed-precision, right-justified to width `w`. */
function fixR(x: number, w: number, p: number): string {
	const s = Number.isNaN(x) ? "nan" : x.toFixed(p)
	return s.padStart(w)
}

function padR(s: string, w: number): string {
	return s.padStart(w)
}

function render(label: string, rows: IntervalRow[], nTotal: number, nAbstain: number): string {
	const out = [
		"",
		`Split-conformal coordinate intervals — ${label}  (#374)`,
		"-".repeat(62),
		`resolved ${nTotal - nAbstain}/${nTotal}  ·  abstained ${nAbstain} (${((100 * nAbstain) / Math.max(nTotal, 1)).toFixed(1)}%)`,
		`${padR("target", 7)} ${padR("radius (km)", 13)} ${padR("realized", 10)} ${padR("n_cal", 7)} ${padR("n_test", 7)}`,
	]
	for (const r of rows) {
		const rad = r.radius_km === Infinity ? "∞" : r.radius_km.toFixed(2)
		out.push(
			`${fixR(r.target_coverage, 7, 2)} ${padR(rad, 13)} ${fixR(r.realized_coverage, 10, 3)} ` +
				`${padR(String(r.n_cal), 7)} ${padR(String(r.n_test), 7)}`
		)
	}
	return out.join("\n")
}

function runSelfTest(): number {
	// Synthetic nonconformity: exponential-ish via a seeded LCG, so realized coverage must track 1−α.
	const scores: number[] = []
	let state = 42n
	for (let i = 0; i < 4000; i++) {
		state = (state * 1103515245n + 12345n) & 0x7fffffffn
		const u = Number(state % 1_000_000n) / 1_000_000 || 1e-6
		scores.push(-20.0 * Math.log(u)) // mean ~20 km
	}
	const alphas = [0.05, 0.1, 0.2]
	const rows = evaluate(scores, alphas, 7, 0.5)
	console.log(render("self-test (synthetic)", rows, scores.length, 0))
	const ok = rows.every((r) => Math.abs(r.realized_coverage - r.target_coverage) < 0.03)
	console.log("\nself-test:", ok ? "PASS" : "FAIL (coverage strayed >0.03 from target)")
	return ok ? 0 : 1
}

interface Args {
	dump?: string
	db: string
	label: string
	alphas: string
	seed: number
	calFrac: number
	outJson?: string
	selfTest: boolean
}

function parseArgs(): Args {
	const argv = process.argv.slice(2)
	const a: Args = {
		db: DEFAULT_DB,
		label: "dump",
		alphas: "0.05,0.1,0.2",
		seed: 20260607,
		calFrac: 0.5,
		selfTest: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i]
		if (k === "--dump") a.dump = argv[++i]
		else if (k === "--db") a.db = argv[++i]!
		else if (k === "--label") a.label = argv[++i]!
		else if (k === "--alphas") a.alphas = argv[++i]!
		else if (k === "--seed") a.seed = parseInt(argv[++i]!, 10)
		else if (k === "--cal-frac") a.calFrac = parseFloat(argv[++i]!)
		else if (k === "--out-json") a.outJson = argv[++i]
		else if (k === "--self-test") a.selfTest = true
	}
	return a
}

function main(): number {
	const args = parseArgs()

	if (args.selfTest) return runSelfTest()
	if (!args.dump) {
		console.error("error: --dump is required (or pass --self-test)")
		return 2
	}

	const alphas = args.alphas.split(",").map((a) => parseFloat(a))
	const [scores, nTotal, nAbstain] = loadScores(args.dump, args.db)
	if (scores.length === 0) {
		console.error("no resolved rows with centroids — nothing to calibrate")
		return 1
	}
	const rows = evaluate(scores, alphas, args.seed, args.calFrac)
	console.log(render(args.label, rows, nTotal, nAbstain))
	if (args.outJson) {
		writeFileSync(
			args.outJson,
			JSON.stringify(
				{
					label: args.label,
					n_total: nTotal,
					n_abstain: nAbstain,
					abstain_rate: nAbstain / Math.max(nTotal, 1),
					intervals: rows,
				},
				null,
				2
			)
		)
		console.error(`\nwrote ${args.outJson}`)
	}
	return 0
}

if (import.meta.main) {
	process.exit(main())
}
