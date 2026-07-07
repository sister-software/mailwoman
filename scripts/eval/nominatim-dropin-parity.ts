#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Drop-in parity harness for `@mailwoman/nominatim` (#806 + #807). Complements the engine-level
 *   `competitive-benchmark.ts` by testing the PACKAGED server endpoint, two ways:
 *
 *   CONTRACT (#806) — every `/search` result is geopy-parseable: `place_id`, `lat`, `lon`,
 *   `display_name`, and (with `addressdetails=1`) an `address` object. This is the shape a real
 *   Nominatim client (geopy, geocoder, …) depends on. ACCURACY (#807) — resolve-rate + coordinate
 *   error (haversine vs a known centroid) over a fixed US + EU query set. "No result" is a miss. A
 *   `nominatim` column is left for recorded baselines (do NOT hit live Nominatim from CI).
 *
 *   Engine-bound (loads the model + gazetteer), so this is a LOCAL tool, not a CI test.
 *
 *   Run (after `yarn compile`, with the WOF gazetteer present): node
 *   scripts/eval/nominatim-dropin-parity.ts [--port 8099] [--out scorecard.md]
 */

import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

import { arg } from "../lib/cli-args.ts"

interface Fixture {
	q: string
	lat: number
	lon: number
	frontier?: boolean
	cc?: string
}
interface ReverseFixture {
	lat: number
	lon: number
	cc: string
}
interface NominatimResult {
	address?: { country_code?: string } | null
	[k: string]: unknown
}
interface SearchRow {
	q: string
	frontier: boolean
	resolved: boolean
	contractOk: boolean
	missing?: string[]
	km: number | null
}
interface ReverseRow {
	ll: string
	contractOk: boolean
	ccOk: boolean
	cc: string | undefined
	expect: string
}
interface OverrideRow {
	q: string
	cc: string
	km: number | null
	ok: boolean
}
interface RobustnessRow {
	label: string
	status: number
	ok: boolean
}

const PORT = Number(arg("port", "8099"))
const OUT = arg("out", "")
const THRESHOLD_KM = 25 // coarse "right place" — the drop-in resolves to admin/centroid, not rooftop

// Fixed query set: city, country, and the city's known centroid (truth). Coarse error = right city.
//
// Two groups. The supported set GATES the harness (a miss is a regression): US queries, which the
// default-on #244 placer routes via the state, and the #743 hard-safelist EU countries (US/ES/IT/NL/
// DE/FR). The `frontier` rows are NOT gated — they track the recall edge: countries the coarse placer
// doesn't yet confidently emit, so a same-name US place wins the resolve (Vienna→Vienna VA). Widening
// `hardCountrySafelist` does NOT move them (measured) — the lever is the placer's country emission
// (#743/#781), GPU model work. As the placer grows, flip a row out of `frontier`.
const FIXTURE: Fixture[] = [
	{ q: "Boston, MA", lat: 42.3601, lon: -71.0589 },
	{ q: "Washington, DC", lat: 38.9072, lon: -77.0369 },
	{ q: "Seattle, WA", lat: 47.6062, lon: -122.3321 },
	{ q: "Austin, TX", lat: 30.2672, lon: -97.7431 },
	{ q: "Berlin, Germany", lat: 52.52, lon: 13.405 },
	{ q: "Paris, France", lat: 48.8566, lon: 2.3522 },
	{ q: "Rotterdam, Netherlands", lat: 51.9244, lon: 4.4777 },
	{ q: "Madrid, Spain", lat: 40.4168, lon: -3.7038 },
	{ q: "Rome, Italy", lat: 41.9028, lon: 12.4964 },
	{ q: "Tokyo, Japan", lat: 35.6762, lon: 139.6503 },
	{ q: "Vienna, Austria", lat: 48.2082, lon: 16.3738, frontier: true, cc: "at" },
	{ q: "Sydney, Australia", lat: -33.8688, lon: 151.2093, frontier: true, cc: "au" },
	{ q: "London, UK", lat: 51.5074, lon: -0.1278, frontier: true, cc: "gb" },
	{ q: "Toronto, Canada", lat: 43.6532, lon: -79.3832, frontier: true, cc: "ca" },
]

// /reverse (geopy's geo.reverse): known coordinate → expected country_code. Exercises the
// WOFReverseGeocoder PIP path, a different code path than /search.
const REVERSE_FIXTURE: ReverseFixture[] = [
	{ lat: 38.8977, lon: -77.0365, cc: "us" },
	{ lat: 42.3601, lon: -71.0589, cc: "us" },
	{ lat: 52.52, lon: 13.405, cc: "de" },
	{ lat: 48.8566, lon: 2.3522, cc: "fr" },
]

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const R = 6371
	const dLat = ((bLat - aLat) * Math.PI) / 180
	const dLon = ((bLon - aLon) * Math.PI) / 180
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2

	return 2 * R * Math.asin(Math.sqrt(s))
}

/** Resolve once the server answers /status, or throw after the deadline. */
async function waitForServer(port: number, deadlineMs: number): Promise<void> {
	const start = Date.now()

	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/status`)

			if (res.ok) return
		} catch {
			/* not up yet */
		}

		if (Date.now() - start > deadlineMs) throw new Error("server did not start within the deadline")
		await new Promise((r) => setTimeout(r, 1000))
	}
}

const CONTRACT_FIELDS = ["place_id", "lat", "lon", "display_name"]

function checkContract(result: NominatimResult, addressdetails: boolean): string[] {
	const missing = CONTRACT_FIELDS.filter((f) => result[f] == null)

	if (addressdetails && (typeof result.address !== "object" || result.address == null)) {
		missing.push("address")
	}

	return missing
}

const server = spawn("node", ["nominatim/out/cli.js", "serve", "--port", String(PORT)], {
	stdio: ["ignore", "ignore", "inherit"],
})

try {
	console.error(`[parity] starting @mailwoman/nominatim on :${PORT} (loads model + gazetteer)…`)
	await waitForServer(PORT, 120_000)

	const rows: SearchRow[] = []

	for (const fx of FIXTURE) {
		const url = `http://127.0.0.1:${PORT}/search?q=${encodeURIComponent(fx.q)}&addressdetails=1`
		let result: NominatimResult | undefined

		try {
			const res = await fetch(url)
			const body = await res.json()
			result = Array.isArray(body) ? body[0] : undefined
		} catch {
			result = undefined
		}

		if (!result) {
			rows.push({ q: fx.q, frontier: !!fx.frontier, resolved: false, contractOk: false, km: null })
			continue
		}
		const missing = checkContract(result, true)
		const km = haversineKm(Number(result.lat), Number(result.lon), fx.lat, fx.lon)
		rows.push({ q: fx.q, frontier: !!fx.frontier, resolved: true, contractOk: missing.length === 0, missing, km })
	}

	// /reverse — contract + did it land in the expected country (PIP over the admin polygons)?
	const revRows: ReverseRow[] = []

	for (const fx of REVERSE_FIXTURE) {
		let result: NominatimResult | undefined

		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/reverse?lat=${fx.lat}&lon=${fx.lon}&addressdetails=1`)
			result = (await res.json()) as NominatimResult
		} catch {
			result = undefined
		}
		const ok = !!(result && typeof result === "object" && !Array.isArray(result))
		const missing = ok ? checkContract(result!, true) : ["(no result)"]
		const cc = ok ? result!.address?.country_code : undefined
		revRows.push({
			ll: `${fx.lat},${fx.lon}`,
			contractOk: ok && missing.length === 0,
			ccOk: cc === fx.cc,
			cc,
			expect: fx.cc,
		})
	}

	// countrycodes override: re-query each frontier row WITH its country code (the #822 manual escape).
	// Shows how many the explicit restriction recovers — partial, since exonyms (Wien/Vienna) + coverage
	// still bite.
	const overrideRows: OverrideRow[] = []

	for (const fx of FIXTURE.filter((f) => f.cc)) {
		let km: number | null = null

		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/search?q=${encodeURIComponent(fx.q)}&countrycodes=${fx.cc}`)
			const body = await res.json()
			const r = Array.isArray(body) ? body[0] : undefined

			if (r) {
				km = haversineKm(Number(r.lat), Number(r.lon), fx.lat, fx.lon)
			}
		} catch {
			/* no result */
		}
		overrideRows.push({ q: fx.q, cc: fx.cc!, km, ok: km != null && km <= THRESHOLD_KM })
	}

	// Robustness: malformed input must degrade (200/4xx), never crash the server (500). These were live
	// 500s before the safe()-wrapper + range/trim guards; gate on them so a regression is caught.
	const robustnessCases = [
		{ label: "search whitespace", url: `/search?q=%20%20` },
		{ label: "search 5000-char", url: `/search?q=${"a".repeat(5000)}` },
		{ label: "reverse out-of-range", url: `/reverse?lat=999&lon=999` },
		{ label: "reverse non-numeric", url: `/reverse?lat=x&lon=y` },
	]
	const robustnessRows: RobustnessRow[] = []

	for (const c of robustnessCases) {
		let status = 0

		try {
			status = (await fetch(`http://127.0.0.1:${PORT}${c.url}`)).status
		} catch {
			/* network error counts as failure */
		}
		robustnessRows.push({ label: c.label, status, ok: status > 0 && status < 500 })
	}

	const supported = rows.filter((r) => !r.frontier)
	const frontier = rows.filter((r) => r.frontier)
	const placedIn = (set: SearchRow[]): SearchRow[] => set.filter((r) => r.resolved && r.km! <= THRESHOLD_KM)
	const contractPass = rows.filter((r) => r.contractOk)
	const errors = placedIn(supported)
		.map((r) => r.km!)
		.sort((a, b) => a - b)
	const median = errors.length ? errors[Math.floor(errors.length / 2)] : null
	const revPass = revRows.filter((r) => r.contractOk && r.ccOk)

	const lines: string[] = []
	lines.push("# @mailwoman/nominatim drop-in parity")
	lines.push("")
	lines.push(`- Forward contract (#806): **${contractPass.length}/${rows.length}** results are geopy-parseable`)
	lines.push(
		`- Resolve-rate @ ${THRESHOLD_KM} km — supported (US + #743 safelist): **${placedIn(supported).length}/${supported.length}**`
	)
	lines.push(`- Conditional median error (supported, placed): **${median == null ? "—" : `${median.toFixed(1)} km`}**`)
	lines.push(`- Placer frontier (#743/#781, not gated): **${placedIn(frontier).length}/${frontier.length}** resolve`)
	lines.push(`- Reverse contract + country (geo.reverse): **${revPass.length}/${revRows.length}**`)
	lines.push(
		`- countrycodes override on frontier (#822 manual escape): **${overrideRows.filter((r) => r.ok).length}/${overrideRows.length}** resolve`
	)
	lines.push(
		`- Robustness — malformed input degrades, never 500: **${robustnessRows.filter((r) => r.ok).length}/${robustnessRows.length}**`
	)
	lines.push("")
	lines.push("| Query | Group | Resolved | Contract | Error (km) |")
	lines.push("| --- | --- | :---: | :---: | ---: |")

	for (const r of rows) {
		lines.push(
			`| ${r.q} | ${r.frontier ? "frontier" : "supported"} | ${r.resolved ? "✅" : "❌"} | ${
				r.contractOk ? "✅" : `❌ ${(r.missing ?? []).join(",")}`
			} | ${r.km == null ? "—" : r.km.toFixed(1)} |`
		)
	}
	lines.push("")
	lines.push("| Reverse (lat,lon) | Contract | Country |")
	lines.push("| --- | :---: | :---: |")

	for (const r of revRows) {
		lines.push(
			`| ${r.ll} | ${r.contractOk ? "✅" : "❌"} | ${r.ccOk ? `✅ ${r.cc}` : `❌ ${r.cc ?? "—"}≠${r.expect}`} |`
		)
	}
	lines.push("")
	lines.push("| Frontier + countrycodes | Resolves | Error (km) |")
	lines.push("| --- | :---: | ---: |")

	for (const r of overrideRows) {
		lines.push(`| ${r.q} + cc=${r.cc} | ${r.ok ? "✅" : "❌"} | ${r.km == null ? "—" : r.km.toFixed(1)} |`)
	}
	lines.push("")
	lines.push("| Malformed input | HTTP | OK |")
	lines.push("| --- | ---: | :---: |")

	for (const r of robustnessRows) {
		lines.push(`| ${r.label} | ${r.status || "—"} | ${r.ok ? "✅" : "❌"} |`)
	}
	const report = lines.join("\n")
	console.log(`\n${report}\n`)

	if (OUT) {
		writeFileSync(OUT, `${report}\n`)
		console.error(`[parity] wrote ${OUT}`)
	}

	// Gate on the forward contract (all rows) + the supported set resolving + reverse contract/country.
	// Frontier misses are expected and tracked, not failures.
	const failed =
		contractPass.length < rows.length ||
		placedIn(supported).length < supported.length ||
		revPass.length < revRows.length ||
		robustnessRows.some((r) => !r.ok)
	process.exitCode = failed ? 1 : 0
} finally {
	server.kill()
}
