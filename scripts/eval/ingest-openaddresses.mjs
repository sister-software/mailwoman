#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ingest-openaddresses.mjs — build the OpenAddresses (OA) US evaluation sample for the
 *   geocoder/resolver end-to-end eval ("OA track" of Direction C).
 *
 *   ## WHY THIS EXISTS
 *
 *   The resolver is admin-level (locality / region / postcode / country — no street geometry). To
 *   measure its _coordinate_ accuracy we need an INDEPENDENT ground-truth set of real US addresses
 *   each carrying a real lat/lon — independent of the WOF gazetteer the resolver itself consults.
 *   OpenAddresses fits: it aggregates authoritative government address points (each with a point
 *   coordinate) and is licensed for open use. We render a human-style address string from the OA
 *   components, keep the OA point as ground truth, and let the eval compute the great-circle error
 *   from the resolved admin centroid to that point.
 *
 *   ## SOURCES (OpenAddresses "latest run" per-source aggregates)
 *
 *   Canonical host: https://results.openaddresses.io/latest/run/<country>/<state>/<source>.zip
 *   (302-redirects to data.openaddresses.io → Cloudflare R2). Each zip contains a CSV with header:
 *   LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH plus a README.txt (packaging
 *   date + per-source license string) and a .vrt (GDAL geometry desc).
 *
 *   We deliberately download only a HANDFUL of specific source files (NOT the whole US collection,
 *   which is many GB), stratified across dense-urban / suburban / rural states so no single state
 *   dominates. The exact source list, sizes, and licenses are in SOURCES below and mirrored in
 *   data/eval/external/README.md.
 *
 *   ## PIPELINE
 *
 *   1. Download each source zip into --cache (skipped if already present). Uses system `curl -L`.
 *   2. Extract the CSV with system `unzip -p` (streamed; no full extraction to disk).
 *   3. Parse CSV → normalize field casing/aliases → filter (require city + postcode, sane street).
 *   4. Dedup within a source on (number, street, city, postcode).
 *   5. Stratified reservoir sample per state to --per-state, then trim to --target overall.
 *   6. Render the canonical address string and emit one JSONL row per record.
 *
 *   ## OUTPUT SCHEMA (one JSON object per line)
 *
 *   { "input": "402 Constitution Avenue NE, Washington, DC 20002", "lat": 38.8921953, "lon":
 *   -77.0003528, "expected": { "locality": "Washington", "region": "DC", "postcode": "20002" },
 *   "state": "DC", "source": "openaddresses:us/dc/statewide" }
 *
 *   ## USAGE
 *
 *   # Full run (downloads ~140 MB across 8 sources, samples ~10k):
 *
 *   Node scripts/eval/ingest-openaddresses.mjs\
 *   --out data/eval/external/openaddresses-us-sample.jsonl\
 *   --cache /tmp/oa-cache --target 10000 --per-state 1500 --seed 42
 *
 *   # If network egress is blocked, pre-download the zips by hand (see README "Manual download"),
 *
 *   # drop them in --cache as <state>__<source>.zip, then run with --offline to skip downloads.
 *
 *   ## FLAGS
 *
 *   --out <path> output JSONL (default data/eval/external/openaddresses-us-sample.jsonl) --cache
 *   <dir> where source zips are cached (default /tmp/oa-cache) --target <n> overall cap on emitted
 *   records (default 10000) --per-state <n> per-state cap before the overall trim (default 1500)
 *   --seed <n> PRNG seed for reproducible sampling (default 42) --offline do not download; only use
 *   zips already in --cache --sources a,b,c restrict to a comma list of source keys (e.g.
 *   "us/dc/statewide,us/wy/statewide")
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Source registry. Each entry is one OpenAddresses "latest run" source aggregate.
// `key` is the path under https://results.openaddresses.io/latest/run/<key>.zip and also the
// stable suffix recorded in the per-row `source` field ("openaddresses:<key>").
// `tier` is informational (stratification rationale); sampling is per-state regardless.
// `license` / `attribution` are recorded for the README; OA US sources are open government data.
// Sizes are the compressed-zip sizes observed 2026-05-30 (for the operator's egress budgeting).
//
// `bbox` is the per-source geo-sanity box for the projection/garbage-point filter. US sources omit
// it and default to the continental-US box; NON-US sources MUST set it or their (legitimately
// non-US) points are dropped wholesale. Fields: { minLat, maxLat, minLon, maxLon }.
// ---------------------------------------------------------------------------
const US_BBOX = { minLat: 15, maxLat: 72, minLon: -180, maxLon: -60 }
const DE_BBOX = { minLat: 47, maxLat: 56, minLon: 5, maxLon: 16 }

const SOURCES = [
	// NOTE: us/ca/san_francisco and us/wy/statewide were evaluated and REJECTED for this eval:
	// the SF source carries NO city/place column (every row dropped by the city filter), and the
	// Wyoming statewide/county sources also lack city values. An admin-level eval needs city, so we
	// use Berkeley + Marin for California instead and omit Wyoming. Re-add via --sources if a future
	// OA run populates their city fields.
	{
		key: "us/ca/berkeley",
		state: "CA",
		tier: "dense-urban",
		zipBytes: 741_962,
		license: "City of Berkeley open data — open use.",
		attribution: "City of Berkeley, California, via OpenAddresses",
	},
	{
		key: "us/ca/marin",
		state: "CA",
		tier: "suburban-west",
		zipBytes: 2_924_056,
		license: "Marin County GIS open data — open use.",
		attribution: "Marin County, California GIS, via OpenAddresses",
	},
	{
		key: "us/il/cook",
		state: "IL",
		tier: "dense-urban",
		zipBytes: 33_970_549,
		license: "Cook County GIS open data — open use.",
		attribution: "Cook County, Illinois GIS, via OpenAddresses",
	},
	{
		key: "us/dc/statewide",
		state: "DC",
		tier: "urban-district",
		zipBytes: 3_811_623,
		license: "DC Open Data — terms: https://dc.gov/page/terms-and-conditions-use-district-data",
		attribution: "District of Columbia (DCGIS), via OpenAddresses",
	},
	{
		key: "us/ia/statewide",
		state: "IA",
		tier: "suburban-rural-midwest",
		zipBytes: 53_587_225,
		license: "Aggregate of Iowa county open-data sources — open use (per-county; mostly public domain).",
		attribution: "Iowa county GIS offices, via OpenAddresses",
	},
	{
		key: "us/mt/statewide",
		state: "MT",
		tier: "rural-west",
		zipBytes: 16_783_753,
		license: "Montana State Library / county sources — open use.",
		attribution: "Montana State Library & county GIS, via OpenAddresses",
	},
	{
		key: "us/vt/statewide",
		state: "VT",
		tier: "rural-northeast",
		zipBytes: 11_378_751,
		license: "Vermont Center for Geographic Information (VCGI) — open use.",
		attribution: "Vermont Center for Geographic Information (VCGI), via OpenAddresses",
	},
	{
		key: "us/sd/statewide",
		state: "SD",
		tier: "rural-plains",
		zipBytes: 8_002_724,
		license: "South Dakota county open-data sources — open use.",
		attribution: "South Dakota county GIS, via OpenAddresses",
	},
	// --- Germany (Latin-script non-US locale probe, 2026-06-02). Select via --sources. The global
	// WOF resolver (admin-global-priority.db) covers DE admin. CITY/POSTCODE columns are populated;
	// German postcodes are 5-digit so the US-shaped cleanPostcode accepts them. Each needs DE_BBOX.
	{
		key: "de/berlin",
		state: "Berlin",
		tier: "de-city-state",
		zipBytes: 8_824_426,
		bbox: DE_BBOX,
		license: "Geoportal Berlin / Berlin open data — open use.",
		attribution: "Land Berlin, via OpenAddresses",
	},
	{
		key: "de/nw/statewide",
		state: "Nordrhein-Westfalen",
		tier: "de-populous-multi-city",
		zipBytes: 120_000_000,
		bbox: DE_BBOX,
		license: "Land NRW / Geobasis NRW — open use (dl-de/by-2-0).",
		attribution: "Geobasis NRW, via OpenAddresses",
	},
	{
		key: "de/sn/statewide",
		state: "Sachsen",
		tier: "de-multi-city",
		zipBytes: 40_000_000,
		bbox: DE_BBOX,
		license: "GeoSN Sachsen — open use.",
		attribution: "Staatsbetrieb Geobasisinformation und Vermessung Sachsen, via OpenAddresses",
	},
]

const RESULTS_BASE = "https://results.openaddresses.io/latest/run"

function parseArgs() {
	const args = process.argv.slice(2)
	const out = {
		out: "data/eval/external/openaddresses-us-sample.jsonl",
		cache: "/tmp/oa-cache",
		target: 10_000,
		perState: 1_500,
		seed: 42,
		offline: false,
		sources: null,
	}
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--out") out.out = args[++i]
		else if (a === "--cache") out.cache = args[++i]
		else if (a === "--target") out.target = parseInt(args[++i], 10)
		else if (a === "--per-state") out.perState = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--offline") out.offline = true
		else if (a === "--sources")
			out.sources = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		else throw new Error(`Unknown flag: ${a}`)
	}
	return out
}

// Deterministic PRNG (mulberry32) so sampling is reproducible from --seed.
function mulberry32(seed) {
	let a = seed >>> 0
	return function () {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function zipPathFor(cache, source) {
	return join(cache, `${source.key.replace(/\//g, "__")}.zip`)
}

function download(source, cache, offline) {
	const dest = zipPathFor(cache, source)
	if (existsSync(dest) && statSync(dest).size > 0) {
		return { dest, downloaded: false }
	}
	if (offline) {
		return { dest, downloaded: false, missing: true }
	}
	const url = `${RESULTS_BASE}/${source.key}.zip`
	process.stderr.write(`  downloading ${source.key} (~${(source.zipBytes / 1e6).toFixed(1)} MB)...\n`)
	const r = spawnSync("curl", ["-sSL", "-m", "600", "-o", dest, url], { stdio: ["ignore", "ignore", "inherit"] })
	if (r.status !== 0) {
		return { dest, downloaded: false, error: `curl exit ${r.status}` }
	}
	if (!existsSync(dest) || statSync(dest).size === 0) {
		return { dest, downloaded: false, error: "empty download" }
	}
	return { dest, downloaded: true }
}

// List the CSV entry inside a zip (the data file is `<key>.csv`, e.g. us/dc/statewide.csv).
function csvEntryName(zipPath) {
	const r = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
	if (r.status !== 0) return null
	const lines = r.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
	return lines.find((l) => l.toLowerCase().endsWith(".csv")) || null
}

// Read the packaged README.txt's "License:" line for the operator's records (best-effort).
function readPackagedLicense(zipPath) {
	const entryR = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
	if (entryR.status !== 0) return null
	const readme = entryR.stdout
		.split("\n")
		.map((s) => s.trim())
		.find((l) => l.toLowerCase().endsWith("readme.txt"))
	if (!readme) return null
	const r = spawnSync("unzip", ["-p", zipPath, readme], { encoding: "utf8" })
	if (r.status !== 0) return null
	const line = r.stdout.split("\n").find((l) => l.toLowerCase().startsWith("license:"))
	return line ? line.replace(/^license:\s*/i, "").trim() : null
}

// Minimal RFC-4180-ish CSV line splitter (handles quoted fields with embedded commas/quotes).
function splitCsv(line) {
	const out = []
	let cur = ""
	let inQuotes = false
	for (let i = 0; i < line.length; i++) {
		const c = line[i]
		if (inQuotes) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"'
					i++
				} else {
					inQuotes = false
				}
			} else {
				cur += c
			}
		} else if (c === '"') {
			inQuotes = true
		} else if (c === ",") {
			out.push(cur)
			cur = ""
		} else {
			cur += c
		}
	}
	out.push(cur)
	return out
}

// OA headers are uppercase but we accept any casing and a few aliases for robustness across sources.
const FIELD_ALIASES = {
	lon: ["lon", "longitude", "x"],
	lat: ["lat", "latitude", "y"],
	number: ["number", "housenumber", "house_number", "addr_number"],
	street: ["street", "road", "addr_street"],
	unit: ["unit"],
	city: ["city", "locality", "place"],
	district: ["district", "county"],
	region: ["region", "state", "province"],
	postcode: ["postcode", "postal_code", "zip", "zipcode", "zip_code"],
}

function buildHeaderIndex(headerCells) {
	const lower = headerCells.map((h) => h.trim().toLowerCase())
	const idx = {}
	for (const [canon, aliases] of Object.entries(FIELD_ALIASES)) {
		idx[canon] = -1
		for (const alias of aliases) {
			const at = lower.indexOf(alias)
			if (at !== -1) {
				idx[canon] = at
				break
			}
		}
	}
	return idx
}

// Title-case a SHOUTING or lower city/street string while preserving directional/ordinal nuance
// lightly (good enough for a human-style rendering; the eval matcher is case-insensitive anyway).
function tidyText(s) {
	if (!s) return s
	const t = s.trim().replace(/\s+/g, " ")
	if (!t) return t
	// If it's mixed case already, leave it. If all-caps or all-lower, title-case it.
	const hasLower = /[a-z]/.test(t)
	const hasUpper = /[A-Z]/.test(t)
	if (hasLower && hasUpper) return t
	return t.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
}

function cleanPostcode(s) {
	if (!s) return ""
	// Some sources emit ZIPs as floats ("94116.0"). Strip a trailing ".0"/".00" before matching.
	const t = s.trim().replace(/\.0+$/, "")
	// Keep US ZIP or ZIP+4. Reject obvious garbage.
	const m = t.match(/^(\d{5})(?:-\d{4})?$/)
	return m ? m[1] : ""
}

function looksLikeNumber(s) {
	return /\d/.test(s)
}

function renderInput({ number, street, city, region, postcode }) {
	const line1 = [number, street].filter(Boolean).join(" ").trim()
	const cityPart = city || ""
	const regionPost = [region, postcode].filter(Boolean).join(" ").trim()
	// "402 Constitution Avenue NE, Washington, DC 20002"
	const parts = []
	if (line1) parts.push(line1)
	if (cityPart) parts.push(cityPart)
	if (regionPost) parts.push(regionPost)
	return parts.join(", ")
}

function processSource(source, zipPath, rng, perState) {
	const csvName = csvEntryName(zipPath)
	if (!csvName) return { error: "no CSV entry in zip" }

	// Stream the CSV out of the zip via `unzip -p` so we never extract the (large) file to disk.
	const unzip = spawnSync("unzip", ["-p", zipPath, csvName], {
		maxBuffer: 1024 * 1024 * 1024,
		encoding: "buffer",
	})
	if (unzip.status !== 0) return { error: `unzip -p failed (status ${unzip.status})` }

	const lines = unzip.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return { error: "empty CSV" }

	const header = splitCsv(lines[0])
	const idx = buildHeaderIndex(header)
	if (idx.lon === -1 || idx.lat === -1) return { error: "no LON/LAT columns" }

	const get = (cells, k) => (idx[k] >= 0 && idx[k] < cells.length ? (cells[idx[k]] ?? "").trim() : "")

	let read = 0
	let kept = 0
	let droppedNoCityOrPost = 0
	let droppedBadGeo = 0
	let droppedBadStreet = 0
	let droppedDup = 0
	const seen = new Set()

	// Reservoir sample of size `perState` for this source's surviving rows.
	const reservoir = []

	for (let li = 1; li < lines.length; li++) {
		const raw = lines[li]
		if (!raw) continue
		read++
		const cells = splitCsv(raw)

		const lon = Number(get(cells, "lon"))
		const lat = Number(get(cells, "lat"))
		if (!Number.isFinite(lon) || !Number.isFinite(lat) || (lon === 0 && lat === 0)) {
			droppedBadGeo++
			continue
		}
		// Per-source geo-sanity box (US sources default to the continental-US box; non-US sources set
		// their own `bbox`). Drops projection/garbage points.
		const box = source.bbox ?? US_BBOX
		if (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon) {
			droppedBadGeo++
			continue
		}

		const number = get(cells, "number")
		const street = tidyText(get(cells, "street"))
		const city = tidyText(get(cells, "city"))
		let region = get(cells, "region").trim().toUpperCase()
		if (!region) region = source.state // OA region is usually populated; fall back to source state.
		const postcode = cleanPostcode(get(cells, "postcode"))

		// Filter: require city AND postcode (resolver is admin-level).
		if (!city || !postcode) {
			droppedNoCityOrPost++
			continue
		}
		// Strip obviously bad rows: a house number with no street.
		if (number && !street) {
			droppedBadStreet++
			continue
		}
		// A street value that's just a number is junk.
		if (street && !/[a-z]/i.test(street)) {
			droppedBadStreet++
			continue
		}

		// Dedup within source on the address identity.
		const dk = `${number}|${street.toLowerCase()}|${city.toLowerCase()}|${postcode}`
		if (seen.has(dk)) {
			droppedDup++
			continue
		}
		seen.add(dk)

		const input = renderInput({ number, street, city, region, postcode })
		if (!input || !looksLikeNumber(input)) {
			// Require at least a house number somewhere so the string reads like a real address.
			droppedBadStreet++
			continue
		}

		const record = {
			input,
			lat,
			lon,
			expected: { locality: city, region, postcode },
			state: region,
			source: `openaddresses:${source.key}`,
		}

		kept++
		// Reservoir sampling (Vitter algorithm R) over the surviving stream.
		if (reservoir.length < perState) {
			reservoir.push(record)
		} else {
			const j = Math.floor(rng() * kept)
			if (j < perState) reservoir[j] = record
		}
	}

	return {
		stats: { read, kept, droppedNoCityOrPost, droppedBadGeo, droppedBadStreet, droppedDup, sampled: reservoir.length },
		records: reservoir,
	}
}

function main() {
	const opts = parseArgs()
	const rng = mulberry32(opts.seed)
	mkdirSync(opts.cache, { recursive: true })

	let sources = SOURCES
	if (opts.sources) {
		sources = SOURCES.filter((s) => opts.sources.includes(s.key))
		if (sources.length === 0) throw new Error(`No known sources match --sources ${opts.sources.join(",")}`)
	}

	process.stderr.write(`OpenAddresses US eval ingest — ${sources.length} source(s), seed=${opts.seed}\n`)

	const perSourceRecords = []
	const report = []
	const blocked = []

	for (const source of sources) {
		process.stderr.write(`\n[${source.state}] ${source.key} (${source.tier})\n`)
		const dl = download(source, opts.cache, opts.offline)
		if (dl.missing) {
			blocked.push({ source: source.key, reason: "offline: zip not found in cache" })
			process.stderr.write(`  SKIP (offline, missing from cache: ${dl.dest})\n`)
			continue
		}
		if (dl.error) {
			blocked.push({ source: source.key, reason: dl.error })
			process.stderr.write(`  SKIP (download failed: ${dl.error})\n`)
			continue
		}

		const packagedLicense = readPackagedLicense(dl.dest)
		const result = processSource(source, dl.dest, rng, opts.perState)
		if (result.error) {
			blocked.push({ source: source.key, reason: result.error })
			process.stderr.write(`  SKIP (parse failed: ${result.error})\n`)
			continue
		}

		const s = result.stats
		process.stderr.write(
			`  read=${s.read} kept=${s.kept} sampled=${s.sampled} ` +
				`| dropped: no-city/post=${s.droppedNoCityOrPost} bad-geo=${s.droppedBadGeo} ` +
				`bad-street=${s.droppedBadStreet} dup=${s.droppedDup}\n`
		)
		perSourceRecords.push({ source, records: result.records })
		report.push({ source: source.key, state: source.state, packagedLicense, ...s })
	}

	// Overall trim to --target, keeping per-state balance: round-robin across sources.
	const byState = new Map()
	for (const { source, records } of perSourceRecords) {
		if (!byState.has(source.state)) byState.set(source.state, [])
		byState.get(source.state).push(...records)
	}
	// Shuffle each state's pool deterministically, then round-robin draw until target.
	for (const arr of byState.values()) {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1))
			;[arr[i], arr[j]] = [arr[j], arr[i]]
		}
	}
	const pools = [...byState.entries()].map(([state, arr]) => ({ state, arr, i: 0 }))
	const final = []
	let progress = true
	while (final.length < opts.target && progress) {
		progress = false
		for (const p of pools) {
			if (p.i < p.arr.length) {
				final.push(p.arr[p.i++])
				progress = true
				if (final.length >= opts.target) break
			}
		}
	}

	// Write output.
	const outPath = resolve(opts.out)
	mkdirSync(dirname(outPath), { recursive: true })
	const body = final.map((r) => JSON.stringify(r)).join("\n") + (final.length ? "\n" : "")
	writeFileSync(outPath, body)

	// Final summary to stderr.
	const stateCounts = {}
	for (const r of final) stateCounts[r.state] = (stateCounts[r.state] || 0) + 1
	process.stderr.write(`\n=== DONE ===\n`)
	process.stderr.write(`wrote ${final.length} records → ${outPath}\n`)
	process.stderr.write(`by state: ${JSON.stringify(stateCounts)}\n`)
	if (blocked.length) {
		process.stderr.write(`\nBLOCKED sources (${blocked.length}):\n`)
		for (const b of blocked) process.stderr.write(`  - ${b.source}: ${b.reason}\n`)
		process.stderr.write(
			`\nTo fetch a blocked source manually, run:\n` +
				blocked
					.map(
						(b) =>
							`  ! curl -sSL -o ${join(opts.cache, b.source.replace(/\//g, "__"))}.zip ` +
							`${RESULTS_BASE}/${b.source}.zip`
					)
					.join("\n") +
				`\nthen re-run this script with --offline.\n`
		)
	}
	// Emit a machine-readable per-source report alongside the data for the README/provenance.
	const reportPath = outPath.replace(/\.jsonl$/, ".report.json")
	writeFileSync(
		reportPath,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				seed: opts.seed,
				target: opts.target,
				perState: opts.perState,
				emitted: final.length,
				byState: stateCounts,
				sources: report,
				blocked,
			},
			null,
			2
		) + "\n"
	)
	process.stderr.write(`report → ${reportPath}\n`)
}

main()
