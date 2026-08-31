#!/usr/bin/env node
//
// open-truth-three-arm — the scorer + query harness behind the 2026-08-18 open-truth three-arm
// record (docs/records/evals/competitive-parity/2026-08-18-open-truth-three-arm.md).
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT
//
// Three geocoders — Mailwoman, Pelias, Photon — are asked the same raw query strings, top-1 result
// only, and each answer is graded by haversine distance against a reference coordinate drawn from an
// open address register (via the OpenAddresses collections). Thresholds are 1 / 5 / 25 km; an arm
// that returns nothing is a miss at every threshold. The protocol is the pre-registered §4 of
// docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md.
//
// The reference coordinates and two of the arms' indexes share upstream data: OpenAddresses is a
// Pelias-indexed source, and Mailwoman's own rooftop registers for AU / NZ / FR derive from the same
// national registers the truth does. Photon's index is OpenStreetMap only. So read the @1 km column
// as "does the engine reproduce the register's rooftop", partly recall-of-own-data for Mailwoman and
// Pelias, and as an OSM-coverage measure for Photon. The record states this beside the tables.
//
// TWO MODES
//
//   score (default)  Recompute every table in the record from the committed per-row results file.
//                    Deterministic, no network. The paired bootstrap (mulberry32, seed 20260807,
//                    1000 resamples) reproduces byte-for-byte.
//   --run            Query live arms over the committed panel and write a fresh results file in the
//                    same shape. Requires a Pelias and a Photon endpoint plus the compiled Mailwoman
//                    CLI. Data footprints are yours to build; the record documents what the original
//                    run used.
//
// USAGE
//
//   node open-truth-three-arm.mjs                       # score the committed results
//   node open-truth-three-arm.mjs --results other.jsonl # score a different results file
//   node open-truth-three-arm.mjs --run \
//     --pelias-url http://localhost:4000 \
//     --photon-url http://localhost:2322 \
//     --mailwoman-cli path/to/mailwoman/out/cli.js \
//     --out results.jsonl
//
// The panel and results default to the committed copies beside this script. This script is
// standalone on purpose (node builtins only, no monorepo install), so the PRNG and haversine are
// local copies of the shared implementations.

// oxlint-disable-next-line typescript/no-restricted-imports -- standalone script (node builtins only, no monorepo install)
import { spawn } from "node:child_process"
// oxlint-disable-next-line typescript/no-restricted-imports -- standalone script (node builtins only, no monorepo install)
import { mkdir, readFile, writeFile } from "node:fs/promises"
// oxlint-disable-next-line typescript/no-restricted-imports -- standalone script (node builtins only, no monorepo install)
import { dirname, join } from "node:path"
// oxlint-disable-next-line typescript/no-restricted-imports -- standalone script (node builtins only, no monorepo install)
import { fileURLToPath } from "node:url"
// oxlint-disable-next-line typescript/no-restricted-imports -- standalone script (node builtins only, no monorepo install)
import { parseArgs } from "node:util"

const HERE = dirname(fileURLToPath(import.meta.url))

const { values: flags } = parseArgs({
	options: {
		run: { type: "boolean", default: false },
		panel: { type: "string", default: join(HERE, "open-truth-panel.jsonl") },
		results: { type: "string", default: join(HERE, "open-truth-results.jsonl") },
		out: { type: "string", default: "open-truth-results.jsonl" },
		"pelias-url": { type: "string", default: "http://localhost:4000" },
		"photon-url": { type: "string", default: "http://localhost:2322" },
		"mailwoman-cli": { type: "string", default: "" },
		concurrency: { type: "string", default: "4" },
	},
})

const THRESHOLDS = [1, 5, 25]

const ARMS = [
	["mailwoman", "mailwoman_km"],
	["pelias", "pelias_km"],
	["photon", "photon_km"],
]

// Haversine — same formula as @mailwoman/spatial (R = 6371 km).
const D2R = Math.PI / 180

function haversineKm(aLat, aLon, bLat, bLon) {
	const dLat = (bLat - aLat) * D2R
	const dLon = (bLon - aLon) * D2R

	const a =
		Math.pow(Math.sin(dLat / 2), 2) + Math.cos(aLat * D2R) * Math.cos(bLat * D2R) * Math.pow(Math.sin(dLon / 2), 2)

	return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// mulberry32 — same stream as @mailwoman/core/utils python-random.ts.
function mulberry32(a) {
	return function () {
		a |= 0
		a = (a + 0x6d_2b_79_f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
	}
}

async function readJSONL(path) {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- standalone script; the committed panel is small and bounded
	const rawLines = (await readFile(path, "utf8")).trim().split("\n")

	// oxlint-disable-next-line no-restricted-properties -- standalone script (no monorepo install); a throw on a corrupt committed file is the contract
	return rawLines.map((l) => JSON.parse(l))
}

const isHit = (d, t) => typeof d === "number" && d <= t

//#region Score mode — recompute the record's tables

async function score() {
	const rows = await readJSONL(flags.results)
	const lanes = [...new Set(rows.map((r) => r.locale))].toSorted()
	const lines = []

	const fmt = (hits, n) => `${hits}/${n} (${((100 * hits) / n).toFixed(1)}%)`

	lines.push("## Per-lane, three arms (n, @1 km, @5 km, @25 km, no result)")
	lines.push("")
	lines.push("| lane | n | arm | @1 km | @5 km | @25 km | no result |")
	lines.push("|---|---|---|---|---|---|---|")

	for (const lane of lanes) {
		const g = rows.filter((r) => r.locale === lane)

		for (const [arm, key] of ARMS) {
			const d = g.map((r) => r[key])
			const none = d.filter((x) => typeof x !== "number").length

			lines.push(
				`| ${lane} | ${g.length} | ${arm} | ${fmt(d.filter((x) => isHit(x, 1)).length, g.length)} | ${fmt(d.filter((x) => isHit(x, 5)).length, g.length)} | ${fmt(d.filter((x) => isHit(x, 25)).length, g.length)} | ${none} |`
			)
		}
	}

	lines.push("")
	lines.push("## Pooled over all published rows")
	lines.push("")
	lines.push("| arm | n | @1 km | @5 km | @25 km | no result |")
	lines.push("|---|---|---|---|---|---|")

	for (const [arm, key] of ARMS) {
		const d = rows.map((r) => r[key])
		const none = d.filter((x) => typeof x !== "number").length

		lines.push(
			`| ${arm} | ${rows.length} | ${fmt(d.filter((x) => isHit(x, 1)).length, rows.length)} | ${fmt(d.filter((x) => isHit(x, 5)).length, rows.length)} | ${fmt(d.filter((x) => isHit(x, 25)).length, rows.length)} | ${none} |`
		)
	}

	// Paired bootstrap on the Mailwoman-minus-Pelias difference, per §4 (seed 20260807, 1000
	// resamples, percentile 2.5/97.5, ±5 pp equivalence bound @25 km).
	lines.push("")
	lines.push("## Paired bootstrap, Mailwoman − Pelias (seed 20260807, 1000 resamples)")
	lines.push("")
	lines.push("| group | n | threshold | mw | pelias | diff | 95% CI |")
	lines.push("|---|---|---|---|---|---|---|")
	let seedCounter = 0

	for (const [label, g] of [["pooled", rows], ...lanes.map((l) => [l, rows.filter((r) => r.locale === l)])]) {
		for (const t of THRESHOLDS) {
			const mw = g.map((r) => isHit(r.mailwoman_km, t))
			const pe = g.map((r) => isHit(r.pelias_km, t))
			const n = g.length
			const rand = mulberry32(20_260_807 + seedCounter++ * 7919)
			const B = 1000
			const diffs = new Float64Array(B)

			for (let b = 0; b < B; b++) {
				let mwHit = 0
				let peHit = 0

				for (let i = 0; i < n; i++) {
					const idx = Math.floor(rand() * n)

					if (mw[idx]) {
						mwHit++
					}

					if (pe[idx]) {
						peHit++
					}
				}

				diffs[b] = mwHit / n - peHit / n
			}

			const sorted = diffs.toSorted()
			const mwRate = (100 * mw.filter(Boolean).length) / n
			const peRate = (100 * pe.filter(Boolean).length) / n
			const lo = 100 * sorted[Math.floor(B * 0.025)]
			const hi = 100 * sorted[Math.floor(B * 0.975)]

			lines.push(
				`| ${label} | ${n} | ${t} km | ${mwRate.toFixed(1)}% | ${peRate.toFixed(1)}% | ${(mwRate - peRate).toFixed(1)} pp | [${lo.toFixed(1)}, ${hi.toFixed(1)}] |`
			)
		}
	}

	lines.push("")
	lines.push("## Rows where an arm returned no result (miss at every threshold)")
	lines.push("")

	for (const r of rows) {
		const none = ARMS.filter(([, key]) => typeof r[key] !== "number").map(([arm]) => arm)

		if (none.length) {
			lines.push(`- ${r.id} (${r.country}): ${none.join(", ")} | ${r.input}`)
		}
	}

	process.stdout.write(lines.join("\n") + "\n")
}

//#endregion

//#region Run mode — query live arms over the committed panel

const LOCALE_MAP = {
	"en-us": "en-US",
	"fr-fr": "fr-FR",
	"de-de": "de-DE",
	"en-au": "en-AU",
	"en-nz": "en-NZ",
	"eu-mixed": "en-US", // no EU-mixed weights package — production default fallback, as in the recorded run
}

/**
 * Bounded retry for the HTTP arms — transient failures only; the third failure is recorded as a no-result, which the
 * protocol scores as a miss at every threshold.
 */
const QUERY_ATTEMPTS = 3

async function fetchTop1(url) {
	let lastErr = null

	for (let attempt = 0; attempt < QUERY_ATTEMPTS; attempt++) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })

			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`)
			}

			const body = await res.json()
			const f = (body.features || [])[0]

			if (!f) {
				return { lat: null, lon: null }
			}

			const [lon, lat] = f.geometry?.coordinates || []

			return { lat: lat ?? null, lon: lon ?? null }
		} catch (error) {
			lastErr = error

			await new Promise((r) => {
				setTimeout(r, 1000 * (attempt + 1))
			})
		}
	}

	process.stderr.write(`query failed (${url}): ${String(lastErr?.message || lastErr)}\n`)

	return { lat: null, lon: null }
}

function queryMailwoman(cli, input, locale) {
	return new Promise((resolvePromise) => {
		const args = ["geocode", "--format", "json", "--locale", locale, "--", input]
		const child = spawn("node", [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
		child.stdout.on("data", (d) => (stdout += d))

		child.on("error", () => {
			clearTimeout(timer)
			resolvePromise({ lat: null, lon: null })
		})

		child.on("close", (code) => {
			clearTimeout(timer)

			if (code !== 0) {
				resolvePromise({ lat: null, lon: null })

				return
			}

			try {
				// Some CLI rows embed raw control characters inside JSON strings; repair before parse.
				// oxlint-disable-next-line no-control-regex -- the control characters are the thing being repaired
				const repaired = stdout.replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (m) =>
					m === "\n" ? "\\n" : " "
				)

				// oxlint-disable-next-line no-restricted-properties -- standalone script (no monorepo install); the catch below is the fallback
				const d = JSON.parse(repaired)

				resolvePromise({
					lat: typeof d.lat === "number" ? d.lat : null,
					lon: typeof d.lon === "number" ? d.lon : null,
				})
			} catch {
				resolvePromise({ lat: null, lon: null })
			}
		})
	})
}

async function run() {
	if (!flags["mailwoman-cli"]) {
		process.stderr.write("--run requires --mailwoman-cli (path to the compiled Mailwoman CLI)\n")
		process.exit(1)
	}

	const rows = await readJSONL(flags.panel)
	const results = new Array(rows.length)
	const concurrency = Number(flags.concurrency)
	let cursor = 0
	let done = 0

	async function work(row, idx) {
		// Fixed per-row arm order, rows in panel order — the §4 round-robin.
		const peliasURL = `${flags["pelias-url"]}/v1/search?text=${encodeURIComponent(row.input)}&size=1`
		const photonURL = `${flags["photon-url"]}/api?q=${encodeURIComponent(row.input)}&limit=1`
		const pe = await fetchTop1(peliasURL)
		const ph = await fetchTop1(photonURL)
		const mw = await queryMailwoman(flags["mailwoman-cli"], row.input, LOCALE_MAP[row.locale] || "en-US")

		const dist = (p) =>
			p.lat === null || p.lon === null ? null : haversineKm(row.truth_lat, row.truth_lon, p.lat, p.lon)

		results[idx] = {
			id: row.id,
			locale: row.locale,
			country: row.country,
			truth_type: row.truth_type,
			input: row.input,
			mailwoman_km: dist(mw),
			pelias_km: dist(pe),
			photon_km: dist(ph),
		}

		done++

		if (done % 25 === 0 || done === rows.length) {
			process.stderr.write(`scored ${done}/${rows.length}\n`)
		}
	}

	async function worker() {
		while (cursor < rows.length) {
			const i = cursor++

			await work(rows[i], i)
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()))

	// The writers helper this replaced created the parent directory first — keep that contract.
	await mkdir(dirname(flags.out), { recursive: true })
	await writeFile(flags.out, results.map((r) => JSON.stringify(r)).join("\n") + "\n")

	process.stderr.write(
		`wrote ${rows.length} rows -> ${flags.out}\nscore them: node open-truth-three-arm.mjs --results ${flags.out}\n`
	)
}

//#endregion

await (flags.run ? run() : score())
