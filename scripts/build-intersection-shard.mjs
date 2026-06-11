#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the REAL-pair intersection training shard (#487). The model scores 0.0 on
 *   intersection_a/b (the intersection-real eval, v4.2.0 baseline) because the training mix has
 *   ZERO intersection-labeled rows — `synth-intersection` config weights (2.0, then 0.2) were
 *   twice a data no-op. This is the missing data.
 *
 *   STREET PAIRS ARE REAL: the same TIGER 2023 EDGES extraction as the eval builder
 *   (scripts/eval/build-intersection-real.ts) — a node where two road edges (MTFCC S1*) with
 *   distinct FULLNAMEs meet is a real crossing. Real pairs avoid teaching fake street-street
 *   co-occurrences (the flaw in the previous synthesizer-backed version of this script, which drew
 *   fabricated names from corpus/src/synthesize-intersection.ts pools).
 *
 *   LEAKAGE POLICY (mirrors the affix shard's VT discipline):
 *
 *   - TRAIN counties: Cook IL (grid city) + Morris NJ (suburb).
 *   - GOLDEN (`--golden`) county: Washington VT (rural) ONLY — the corpus defaultHoldout state,
 *       never sampled by train mode.
 *   - Every crossing in data/eval/external/intersection-real.jsonl is excluded from BOTH modes, by
 *       node id AND by order-insensitive name pair (the eval shares all three counties).
 *
 *   RENDERING: junction-format variety per the night-10 audit — padded/TIGHT `&` and `/`, `and`,
 *   `at`, `@`, leading-phrase `corner of` / `intersection of` — crossed with tails (bare / `, ST` /
 *   `, ST ZIP` / `, City, ST [ZIP]`) and case variants (as-is / UPPER / lower). ZIPs are the
 *   crossing's own TIGER edge ZIPL (real); the locality tail comes from the OA Cook-county
 *   ZIP→city majority map (real pairing; NJ crossings get region/ZIP tails only — no OA NJ source
 *   in the cache). Span convention matches the eval gold: intersection_a/b cover each street
 *   INCLUDING directional + suffix ("S Loomis Blvd"); connector tokens are O.
 *
 *   A JSON report (counts per form/tail/case + samples) lands next to the output.
 *
 *   Inputs (already on disk; do not re-download):
 *
 *   - /tmp/tiger-edges/tl_2023_{17031,34027,50023}_edges.shp (unzipped TIGER 2023 EDGES)
 *   - /tmp/oa-cache/us__il__cook.zip (ZIP→city tails)
 *
 *   Pipeline:
 *     node scripts/build-intersection-shard.mjs --output /tmp/intersection-shard/intersection-train.jsonl \
 *       --count 40000 --seed 42
 *     node scripts/build-intersection-shard.mjs --output /tmp/intersection-shard/intersection-golden.jsonl \
 *       --golden --count 500 --seed 99
 *     python3 scripts/jsonl-to-parquet.py --input /tmp/intersection-shard/intersection-train.jsonl \
 *       --output /tmp/intersection-shard/part-intersection-train.parquet
 */

import { spawnSync } from "node:child_process"
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { DuckDBInstance } from "@duckdb/node-api"
import { alignRow, stableSourceId } from "@mailwoman/corpus"

const TRAIN_COUNTIES = [
	{ fips: "17031", state: "IL", regime: "grid-city" },
	{ fips: "34027", state: "NJ", regime: "suburb" },
]
const GOLDEN_COUNTIES = [{ fips: "50023", state: "VT", regime: "rural" }]

const EVAL_GOLD_PATH = fileURLToPath(new URL("../data/eval/external/intersection-real.jsonl", import.meta.url))
const OA_COOK = { zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv" }

/**
 * Junction forms. Weights favor the common connectors; the tight (unpadded) variants and leading
 * phrases get enough mass to register (each ≥5%) — they're the audited gaps the old synth missed.
 */
const FORMS = [
	{ id: "amp", w: 0.2, render: (a, b) => `${a} & ${b}` },
	{ id: "and", w: 0.2, render: (a, b) => `${a} and ${b}` },
	{ id: "at", w: 0.12, render: (a, b) => `${a} at ${b}` },
	{ id: "slash", w: 0.08, render: (a, b) => `${a} / ${b}` },
	{ id: "slash-tight", w: 0.06, render: (a, b) => `${a}/${b}` },
	{ id: "amp-tight", w: 0.05, render: (a, b) => `${a}&${b}` },
	{ id: "at-sign", w: 0.06, render: (a, b) => `${a} @ ${b}` },
	{ id: "corner-of", w: 0.115, render: (a, b) => `corner of ${a} and ${b}` },
	{ id: "intersection-of", w: 0.115, render: (a, b) => `intersection of ${a} and ${b}` },
]

/**
 * Tail forms. ~55% bare (the v0.7.2 lesson: an always-present tail taught the model to read
 * post-intersection text as a locality and fumble bare "X & Y"). City tails require a ZIP→city hit
 * (Cook only); ZIP tails require the edge to carry a ZIPL. Misses downgrade to the region tail.
 */
const TAILS = [
	{ id: "bare", w: 0.55 },
	{ id: "region", w: 0.16 },
	{ id: "region-zip", w: 0.09 },
	{ id: "city-region", w: 0.08 },
	{ id: "city-region-zip", w: 0.12 },
]

const CASES = [
	{ id: "as-is", w: 0.82, apply: (s) => s },
	{ id: "upper", w: 0.12, apply: (s) => s.toUpperCase() },
	{ id: "lower", w: 0.06, apply: (s) => s.toLowerCase() },
]

/**
 * Street names that would make the connector ambiguous or break verbatim alignment: embedded
 * connector punctuation, or a standalone "and"/"at" word.
 */
const BAD_NAME = /[,&@/]|\b(and|at)\b/i

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 40000, seed: 42, source: "synth-intersection", golden: false, edgesDir: "/tmp/tiger-edges" }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--edges-dir") out.edgesDir = args[++i]
		else if (a === "--golden") out.golden = true
	}
	if (!out.output) {
		console.error(
			"Usage: build-intersection-shard.mjs --output <labeled.jsonl> [--count N] [--seed N] [--golden] [--edges-dir /tmp/tiger-edges]"
		)
		process.exit(1)
	}
	return out
}

/** Mulberry32 — reproducible PRNG (matches the other shard builders). */
function mulberry32(seed) {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function weightedPick(items, random) {
	const total = items.reduce((s, x) => s + x.w, 0)
	let r = random() * total
	for (const item of items) {
		r -= item.w
		if (r <= 0) return item
	}
	return items[items.length - 1]
}

/** Minimal RFC-4180-ish splitter (handles quoted fields) — same as the affix builder. */
function splitCsv(line) {
	const out = []
	let cur = ""
	let inQ = false
	for (let i = 0; i < line.length; i++) {
		const c = line[i]
		if (inQ) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"'
					i++
				} else inQ = false
			} else cur += c
		} else if (c === '"') inQ = true
		else if (c === ",") {
			out.push(cur)
			cur = ""
		} else cur += c
	}
	out.push(cur)
	return out
}

/** Order-insensitive crossing key, for eval-leakage exclusion + pair dedup. */
const pairKey = (a, b) => [a.toLowerCase(), b.toLowerCase()].sort().join("\x1f")

/** Load the eval's crossings so neither train nor golden ever sees them. */
function readEvalExclusions() {
	const nodes = new Set()
	const pairs = new Set()
	if (!existsSync(EVAL_GOLD_PATH)) {
		console.error(`  WARN: eval gold not found at ${EVAL_GOLD_PATH} — no eval-leakage exclusion applied`)
		return { nodes, pairs }
	}
	for (const line of readFileSync(EVAL_GOLD_PATH, "utf8").split("\n")) {
		if (!line) continue
		const row = JSON.parse(line)
		nodes.add(Number(row.node))
		pairs.add(pairKey(row.components.intersection_a, row.components.intersection_b))
	}
	return { nodes, pairs }
}

/**
 * Extract real crossings from one county's TIGER EDGES shapefile. Same query shape as the eval
 * builder (2 incident distinct S1* FULLNAMEs at a node, both names >=6 chars), plus the edge ZIPL
 * so tails can carry the crossing's own ZIP. Hash-ordered for seed-stable determinism.
 */
async function extractCrossings(db, edgesDir, county, seed) {
	const shp = `${edgesDir}/tl_2023_${county.fips}_edges.shp`
	const result = await db.runAndReadAll(`
		WITH incidence AS (
			SELECT TNIDF AS node, FULLNAME AS name, ZIPL AS zip
			FROM ST_Read('${shp}') WHERE MTFCC LIKE 'S1%' AND FULLNAME IS NOT NULL
			UNION ALL
			SELECT TNIDT AS node, FULLNAME AS name, ZIPL AS zip
			FROM ST_Read('${shp}') WHERE MTFCC LIKE 'S1%' AND FULLNAME IS NOT NULL
		),
		nodes AS (
			SELECT node,
				list_sort(list_distinct(list(name))) AS names,
				max(zip) AS zip
			FROM incidence GROUP BY node
			HAVING len(list_distinct(list(name))) = 2
		)
		SELECT node, names[1] AS a, names[2] AS b, zip,
			hash(node::VARCHAR || '${seed}') AS h
		FROM nodes
		WHERE len(names[1]) >= 6 AND len(names[2]) >= 6
		ORDER BY h
	`)
	const out = []
	for (const r of result.getRowObjects()) {
		out.push({
			a: String(r.a),
			b: String(r.b),
			zip: r.zip == null ? null : String(r.zip),
			node: Number(r.node),
			fips: county.fips,
			state: county.state,
		})
	}
	return out
}

/** ZIP → majority city from the cached OA Cook-county CSV (real ZIP/city pairings). */
function buildZipCityMap() {
	const r = spawnSync("unzip", ["-p", OA_COOK.zip, OA_COOK.csv], { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" })
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${OA_COOK.zip} — city tails disabled`)
		return new Map()
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return new Map()
	const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase())
	const iCity = header.indexOf("city")
	const iPost = header.indexOf("postcode")
	const counts = new Map() // zip → Map(city → n)
	for (let li = 1; li < lines.length; li++) {
		if (!lines[li]) continue
		const cells = splitCsv(lines[li])
		const city = (cells[iCity] ?? "").trim()
		const zip = (cells[iPost] ?? "").trim()
		if (!city || !/^\d{5}$/.test(zip) || BAD_NAME.test(city)) continue
		let byCity = counts.get(zip)
		if (!byCity) counts.set(zip, (byCity = new Map()))
		byCity.set(city, (byCity.get(city) ?? 0) + 1)
	}
	const map = new Map()
	for (const [zip, byCity] of counts) {
		let best = null
		for (const [city, n] of byCity) if (!best || n > best.n) best = { city, n }
		map.set(zip, best.city)
	}
	return map
}

/**
 * Render one crossing → { raw, components, formId, tailId, caseId }. Components are inserted in
 * claim order (streets first) so alignment can't grab a region/postcode lookalike inside a street.
 */
function renderRow(random, crossing, zipCity) {
	const form = weightedPick(FORMS, random)
	const body = form.render(crossing.a, crossing.b)

	let tail = weightedPick(TAILS, random)
	const city = crossing.zip ? (zipCity.get(crossing.zip) ?? null) : null
	// Downgrade unsatisfiable tails (no ZIP on the edge / no city for the ZIP) to the region tail.
	if ((tail.id === "region-zip" || tail.id === "city-region-zip") && !crossing.zip) tail = TAILS[1]
	if ((tail.id === "city-region" || tail.id === "city-region-zip") && !city) tail = TAILS[1]

	const components = { intersection_a: crossing.a, intersection_b: crossing.b }
	let raw = body
	if (tail.id === "region") {
		raw = `${body}, ${crossing.state}`
		components.region = crossing.state
	} else if (tail.id === "region-zip") {
		raw = `${body}, ${crossing.state} ${crossing.zip}`
		components.region = crossing.state
		components.postcode = crossing.zip
	} else if (tail.id === "city-region") {
		raw = `${body}, ${city}, ${crossing.state}`
		components.locality = city
		components.region = crossing.state
	} else if (tail.id === "city-region-zip") {
		raw = `${body}, ${city}, ${crossing.state} ${crossing.zip}`
		components.locality = city
		components.region = crossing.state
		components.postcode = crossing.zip
	}

	const casing = weightedPick(CASES, random)
	raw = casing.apply(raw)
	// Components keep their original case; alignRow matches case-insensitively and labels the
	// tokens of the (cased) raw — the parquet row carries tokens+labels only.
	return { raw, components, formId: form.id, tailId: tail.id, caseId: casing.id }
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)
	const counties = opts.golden ? GOLDEN_COUNTIES : TRAIN_COUNTIES
	const exclusions = readEvalExclusions()
	console.error(`  eval exclusions: ${exclusions.nodes.size} nodes, ${exclusions.pairs.size} pairs`)

	const instance = await DuckDBInstance.create()
	const db = await instance.connect()
	await db.run("INSTALL spatial; LOAD spatial;")

	// Pool real crossings: eval-excluded, connector-safe names, one crossing per distinct pair.
	const pool = []
	const seenPairs = new Set()
	const stats = { evalExcluded: 0, badName: 0, dupPair: 0 }
	for (const county of counties) {
		const crossings = await extractCrossings(db, opts.edgesDir, county, opts.seed)
		let kept = 0
		for (const c of crossings) {
			const key = pairKey(c.a, c.b)
			if (exclusions.nodes.has(c.node) || exclusions.pairs.has(key)) {
				stats.evalExcluded++
				continue
			}
			if (BAD_NAME.test(c.a) || BAD_NAME.test(c.b) || c.a.includes(c.b) || c.b.includes(c.a)) {
				stats.badName++
				continue
			}
			if (seenPairs.has(key)) {
				stats.dupPair++
				continue
			}
			seenPairs.add(key)
			pool.push(c)
			kept++
		}
		console.error(`  ${county.fips} (${county.state}, ${county.regime}): ${crossings.length} crossings, ${kept} kept`)
	}
	if (pool.length === 0) {
		console.error(`No crossings found — are the TIGER EDGES shapefiles present in ${opts.edgesDir}?`)
		process.exit(1)
	}

	const zipCity = opts.golden ? new Map() : buildZipCityMap()
	if (!opts.golden) console.error(`  zip→city map: ${zipCity.size} ZIPs (OA Cook)`)

	const outStream = createWriteStream(opts.output, { encoding: "utf8" })
	let emitted = 0
	let skipped = 0
	let guard = 0
	const formCounts = {}
	const tailCounts = {}
	const caseCounts = {}
	const countyCounts = {}
	const usedCrossings = new Set()
	const seenRaw = new Set()
	const samples = []

	while (emitted < opts.count && guard++ < opts.count * 10) {
		const crossing = pool[Math.floor(random() * pool.length)]
		const { raw, components, formId, tailId, caseId } = renderRow(random, crossing, zipCity)
		if (seenRaw.has(raw)) {
			skipped++
			continue
		}

		if (opts.golden) {
			seenRaw.add(raw)
			outStream.write(JSON.stringify({ raw, components, country: "US", form: formId }) + "\n")
			formCounts[formId] = (formCounts[formId] ?? 0) + 1
			tailCounts[tailId] = (tailCounts[tailId] ?? 0) + 1
			caseCounts[caseId] = (caseCounts[caseId] ?? 0) + 1
			countyCounts[crossing.fips] = (countyCounts[crossing.fips] ?? 0) + 1
			usedCrossings.add(crossing.node)
			emitted++
			continue
		}

		const canonical = {
			raw,
			components,
			country: "US",
			locale: "en-US",
			source: opts.source,
			source_id: stableSourceId(opts.source, components),
			corpus_version: "0.4.0",
			license: "TIGER/Line 2023 EDGES (US Census, public domain) real street pairs; OA Cook IL zip-to-city tails",
		}
		// Verbatim-only alignment: raw is built from the component values, so a fuzzy fallback could
		// only ever mislabel (e.g. claim a lookalike window for a near-duplicate street).
		const aligned = alignRow(canonical, { maxEditDistance: 0 })
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}

		seenRaw.add(raw)
		outStream.write(JSON.stringify({ ...aligned.row, synth_method: "intersection", synth_base_id: null }) + "\n")
		formCounts[formId] = (formCounts[formId] ?? 0) + 1
		tailCounts[tailId] = (tailCounts[tailId] ?? 0) + 1
		caseCounts[caseId] = (caseCounts[caseId] ?? 0) + 1
		countyCounts[crossing.fips] = (countyCounts[crossing.fips] ?? 0) + 1
		usedCrossings.add(crossing.node)
		if (samples.length < FORMS.length && !samples.some((s) => s.form === formId)) {
			samples.push({ form: formId, raw, tokens: aligned.row.tokens, labels: aligned.row.labels })
		}
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))

	const report = {
		mode: opts.golden ? "golden" : "train",
		rows: emitted,
		skipped,
		pool: { crossings: pool.length, used: usedCrossings.size, ...stats },
		per_county: countyCounts,
		forms: formCounts,
		tails: tailCounts,
		cases: caseCounts,
		seed: opts.seed,
		source: "TIGER2023 EDGES via DuckDB ST_Read; node = 2 distinct S1* FULLNAMEs; eval crossings excluded",
		samples,
	}
	writeFileSync(opts.output.replace(/\.jsonl$/, ".report.json"), JSON.stringify(report, null, "\t"))
	console.error(
		`Done: emitted ${emitted} rows (skipped ${skipped}) from ${usedCrossings.size}/${pool.length} real crossings. → ${opts.output}\n` +
			`  forms: ${JSON.stringify(formCounts)}\n` +
			`  tails: ${JSON.stringify(tailCounts)}\n` +
			`  cases: ${JSON.stringify(caseCounts)}`
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
