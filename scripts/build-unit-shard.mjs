#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the US secondary-unit coverage shard (#451, the v0-parity `unit` gap). The `unit` tag
 *   trains at ~0% because the corpus barely carries it; this raises PREVALENCE (DeepSeek-signed
 *   recipe, 2026-06-08) with a unit-heavy shard.
 *
 *   Reads REAL US OpenAddresses tuples (cached zips), and onto each real skeleton INJECTS a USPS
 *   Pub-28 Appendix C2 secondary-unit designator (the `@mailwoman/codex/us` table the #454 synth
 *   augmentation uses), varying the surface form (canonical "Apartment" vs approved "Apt") per row so
 *   the model sees both. OA's own UNIT column is a bare identifier ("A", "1") with no designator — we
 *   reuse it as the unit id when present, else synthesize a plausible id. Renders via the corpus
 *   `formatAddress` (US template), aligns to BIO, writes labeled JSONL ready for parquet.
 *
 *   LEAKAGE-SAFE EVAL (`--golden`): the held-out eval uses the VERMONT source only (Vermont is the
 *   corpus `defaultHoldout` — never trained), a different seed, and emits `{raw, components}` for
 *   per-locale-f1. Train uses every NON-Vermont US source. Geographic split = no overlap.
 *   NOTE: designators are INJECTED in both train and eval (OA carries none), so the eval measures
 *   "designator recognition on held-out addresses", not real-in-the-wild designators — the real-
 *   designator signal lives in the libpostal/postal arenas. Keep both lenses.
 *
 *   Pipeline (mirrors build-german-shard.mjs):
 *     node scripts/build-unit-shard.mjs --output /tmp/unit-train.jsonl --count 50000 --seed 42
 *     node scripts/build-unit-shard.mjs --output /tmp/unit-val.jsonl  --golden --seed 99
 *     python3 scripts/jsonl-to-parquet.py --input /tmp/unit-train.jsonl --output /tmp/part-unit-train.parquet
 */

import { spawnSync } from "node:child_process"
import { createWriteStream } from "node:fs"

import { US_UNIT_DESIGNATOR_PREFERRED_ABBR, US_UNIT_DESIGNATOR_VARIANTS } from "@mailwoman/codex/us"
import { alignRow, stableSourceId } from "@mailwoman/corpus"

// OA REGION is empty for US per-state extracts — the region is implied by the file, like the German
// shard. Train sources are every NON-Vermont state cached; eval is Vermont only (the corpus holdout).
const TRAIN_SOURCES = [
	{ zip: "/tmp/oa-cache/us__ca__berkeley.zip", csv: "us/ca/berkeley.csv", region: "CA" },
	{ zip: "/tmp/oa-cache/us__ca__marin.zip", csv: "us/ca/marin.csv", region: "CA" },
	{ zip: "/tmp/oa-cache/us__dc__statewide.zip", csv: "us/dc/statewide.csv", region: "DC" },
	{ zip: "/tmp/oa-cache/us__ia__statewide.zip", csv: "us/ia/statewide.csv", region: "IA" },
	{ zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv", region: "IL" },
	{ zip: "/tmp/oa-cache/us__mt__statewide.zip", csv: "us/mt/statewide.csv", region: "MT" },
	{ zip: "/tmp/oa-cache/us__sd__statewide.zip", csv: "us/sd/statewide.csv", region: "SD" },
]
const EVAL_SOURCE = { zip: "/tmp/oa-cache/us__vt__statewide.zip", csv: "us/vt/statewide.csv", region: "VT" }

// USPS Pub-28 C2 designators that take a secondary identifier ("Apt 4B"). Weighted toward the common
// ones the v0-parity arena failed on (Apt/Ste/Unit/Fl/Rm). Standalone designators (Basement, Lobby,
// Penthouse) are emitted occasionally with no id.
const ID_DESIGNATORS = ["APARTMENT", "SUITE", "UNIT", "FLOOR", "ROOM", "BUILDING", "DEPARTMENT", "SPACE", "LOT"]
const STANDALONE_DESIGNATORS = ["BASEMENT", "LOBBY", "PENTHOUSE", "FRONT", "REAR", "UPPER", "LOWER"]
const ID_WEIGHT = 0.85 // 85% id-bearing designators, 15% standalone
const SYNTH_IDS = ["4B", "200", "12", "3", "A", "101", "5", "2A", "310", "B", "7", "1500", "404"]

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 50000, seed: 42, source: "synth-unit", golden: false }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--golden") out.golden = true
	}
	if (!out.output) {
		console.error("Usage: build-unit-shard.mjs --output <labeled.jsonl> [--count N] [--seed N] [--golden]")
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

/** Minimal RFC-4180-ish splitter (handles quoted fields). */
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

/** Stream real US tuples (number/street/city/postcode + the bare OA unit id) out of a cached OA zip. */
function readTuples(source) {
	const r = spawnSync("unzip", ["-p", source.zip, source.csv], { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" })
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)
		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return []
	const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase())
	const idx = (name) => header.indexOf(name)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iUnit = idx("unit"),
		iCity = idx("city"),
		iPost = idx("postcode")
	const get = (cells, i) => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples = []
	const seen = new Set()
	for (let li = 1; li < lines.length; li++) {
		if (!lines[li]) continue
		const cells = splitCsv(lines[li])
		const street = get(cells, iStreet)
		const locality = get(cells, iCity)
		const house_number = get(cells, iNum)
		if (!street || !locality || !house_number) continue
		const key = `${house_number}|${street}|${locality}`.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({ house_number, street, locality, region: source.region, postcode: get(cells, iPost), oaUnit: get(cells, iUnit) })
	}
	return tuples
}

/** Title-case a canonical/abbrev designator ("APARTMENT" → "Apartment", "APT" → "Apt"). */
const title = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/** Build an injected unit string ("Apt 4B"), varying canonical vs approved-abbrev form per row. */
function makeUnit(random, oaUnit) {
	const standalone = random() >= ID_WEIGHT
	const pool = standalone ? STANDALONE_DESIGNATORS : ID_DESIGNATORS
	const canonical = pool[Math.floor(random() * pool.length)]
	// Vary the surface form 50/50 (this is the #454 expand/abbreviate variety, baked into the shard).
	const designator = random() < 0.5 ? title(canonical) : title(US_UNIT_DESIGNATOR_PREFERRED_ABBR[canonical])
	if (standalone) return designator
	const id = oaUnit && oaUnit.length <= 6 ? oaUnit : SYNTH_IDS[Math.floor(random() * SYNTH_IDS.length)]
	return `${designator} ${id}`
}

/** Synthetic recipient/venue prefixes — the "JOHN DOE, ACME INC, ..." arena pattern. */
const VENUES = [
	"John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Stark Industries",
	"Globex Corp", "Maria Garcia", "Robert Chen", "Oak Street Dental", "Riverside Clinic",
]

/** Address tail: "City, ST 12345" (or no postcode). */
const tail = (loc, reg, pc) => (pc ? `${loc}, ${reg} ${pc}` : `${loc}, ${reg}`)

/**
 * Render a unit row in a RANDOM layout. v1 trained ONLY unit-after-street in a full address, so the
 * arena's unit-first ("Ste 12, 123 Main St") and bare ("Flat 2 14 Smith St") formats stayed at 0% —
 * an in-distribution mirage (held-out VT eval read 98.7%, real-designator arena 0%). v2 spreads units
 * across positions + drops the city/state tail on bare rows + prefixes a recipient/venue, so the model
 * learns to RECOGNIZE the designator wherever it sits. Returns {fmt, raw, components}.
 */
function renderUnit(random, base, unit) {
	const hn = base.house_number, street = base.street, loc = base.locality, reg = base.region, pc = base.postcode
	const road = `${hn} ${street}`
	const full = { house_number: hn, street, unit, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) }
	const r = random()
	if (r < 0.34) return { fmt: "full-after", raw: `${road} ${unit}, ${tail(loc, reg, pc)}`, components: full }
	if (r < 0.52) return { fmt: "full-first", raw: `${unit}, ${road}, ${tail(loc, reg, pc)}`, components: full }
	if (r < 0.68) return { fmt: "bare-after", raw: `${road} ${unit}`, components: { house_number: hn, street, unit } }
	if (r < 0.84) return { fmt: "bare-first", raw: `${unit} ${road}`, components: { house_number: hn, street, unit } }
	const v = VENUES[Math.floor(random() * VENUES.length)]
	return { fmt: "venue", raw: `${v}, ${road} ${unit}, ${tail(loc, reg, pc)}`, components: { venue: v, ...full } }
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)
	const sources = opts.golden ? [EVAL_SOURCE] : TRAIN_SOURCES

	const pool = []
	for (const s of sources) {
		const t = readTuples(s)
		console.error(`  ${s.csv}: ${t.length} unique tuples`)
		for (const x of t) pool.push(x)
	}
	if (pool.length === 0) {
		console.error("No US tuples found — are the cached OA zips present in /tmp/oa-cache?")
		process.exit(1)
	}

	const outStream = createWriteStream(opts.output, { encoding: "utf8" })
	let emitted = 0
	let skipped = 0
	let guard = 0
	const designatorCounts = {}
	const formatCounts = {}
	const N = pool.length
	while (emitted < opts.count && guard++ < opts.count * 6) {
		const base = pool[Math.floor(random() * N)]
		const unit = makeUnit(random, base.oaUnit)
		const { fmt, raw, components } = renderUnit(random, base, unit)
		// The unit must survive verbatim in raw, else alignment can't label it.
		if (!raw.includes(unit)) {
			skipped++
			continue
		}
		const headWord = unit.split(/\s+/)[0]
		designatorCounts[headWord] = (designatorCounts[headWord] ?? 0) + 1
		formatCounts[fmt] = (formatCounts[fmt] ?? 0) + 1

		if (opts.golden) {
			outStream.write(JSON.stringify({ raw, components, country: "US" }) + "\n")
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
			license: "OpenAddresses US (non-VT) skeletons + injected USPS Pub-28 C2 unit designators",
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}
		outStream.write(JSON.stringify({ ...aligned.row, synth_method: "unit", synth_base_id: null }) + "\n")
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(
		`Done: emitted ${emitted} unit rows, skipped ${skipped} (pool ${pool.length}). → ${opts.output}\n` +
			`  formats: ${JSON.stringify(formatCounts)}\n` +
			`  leading designators: ${JSON.stringify(designatorCounts)}`
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
