#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the US street-affix coverage shard (the v0-parity `street_prefix` / `street_suffix` gap —
 *   both ~0% F1 in the #15 assessment, collapsed into `street`). Mirrors build-unit-shard.mjs: raise
 *   PREVALENCE of affix-split streets with format diversity so the model learns to split
 *   "N Main St" → street_prefix="N" + street="Main" + street_suffix="St", and (negative space) sharpen
 *   `street` itself.
 *
 *   Reads REAL US OpenAddresses tuples and SPLITS the OA `street` field via the codex:
 *   `matchLeadingDirectional` (USPS Pub-28 C1) for the prefix, `matchTrailingSuffix` (Pub-28 C2 street
 *   suffixes) for the suffix. OA streets nearly all carry a suffix; only ~10-20% carry a directional,
 *   so we INJECT a directional prefix onto a fraction of prefix-less streets (same move as the unit
 *   shard injecting designators onto bare skeletons) to give `street_prefix` real signal. Each row
 *   varies surface form per affix — abbreviated ("N", "St") vs expanded ("North", "Street") — so the
 *   model sees both, and varies the layout (full address / bare / street-only / venue-prefixed).
 *
 *   LEAKAGE-SAFE EVAL (`--golden`): held-out eval uses the VERMONT source only (the corpus
 *   defaultHoldout), a different seed, and emits {raw, components} for per-locale-f1. Train uses every
 *   NON-Vermont US source. The real-in-the-wild affix signal lives in data/eval/external/
 *   street-affix-real.jsonl + the libpostal/postal arenas — read both lenses at the gate.
 *
 *   Pipeline (mirrors build-unit-shard.mjs):
 *     node scripts/build-street-affix-shard.mjs --output /tmp/affix-train.jsonl --count 50000 --seed 42
 *     node scripts/build-street-affix-shard.mjs --output /tmp/affix-val.jsonl --golden --seed 99
 *     python3 scripts/jsonl-to-parquet.py --input /tmp/affix-train.jsonl --output /tmp/part-affix-train.parquet
 */

import { spawnSync } from "node:child_process"
import { createWriteStream } from "node:fs"

import {
	DirectionalAbbreviation,
	lookupDirectional,
	matchCase,
	matchLeadingDirectional,
	matchTrailingSuffix,
	renderDirectional,
	US_STREET_SUFFIX_PREFERRED_ABBR,
} from "@mailwoman/codex/us"
import { alignRow, stableSourceId } from "@mailwoman/corpus"

// Same OA cache as the unit shard. Train = every NON-Vermont state; eval = Vermont (the holdout).
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

const DIRECTIONAL_ABBRS = Object.values(DirectionalAbbreviation) // ["N","E","S","W","NE","NW","SE","SW"]
const INJECT_PREFIX_PROB = 0.3 // fraction of prefix-less streets that get a synthetic directional

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 50000, seed: 42, source: "synth-affix", golden: false }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--golden") out.golden = true
	}
	if (!out.output) {
		console.error("Usage: build-street-affix-shard.mjs --output <labeled.jsonl> [--count N] [--seed N] [--golden]")
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

/** Stream real US tuples (number/street/city/postcode) out of a cached OA zip. */
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
		tuples.push({ house_number, street, locality, region: source.region, postcode: get(cells, iPost) })
	}
	return tuples
}

const title = (s) =>
	s
		.toLowerCase()
		.split(/\s+/)
		.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(" ")

const isSuffixOrDirectional = (word) => matchTrailingSuffix(word) !== null || matchLeadingDirectional(word) !== null

/**
 * Split an OA street into { prefix?, name, suffix } using the codex. Requires a trailing suffix and a
 * non-empty name that isn't itself an affix token. Returns null when the street has no usable suffix.
 */
function parseStreet(street) {
	let words = street.trim().split(/\s+/)
	if (words.length < 2) return null
	let prefix = null
	// Leading directional — only if it leaves ≥2 words behind (room for a name + suffix).
	const lead = matchLeadingDirectional(street)
	if (lead && words.length > 2) {
		prefix = { canonical: lead.canonical, abbreviation: lead.abbreviation }
		words = words.slice(1)
	}
	// Trailing USPS suffix — only if it leaves ≥1 word for the name.
	const trail = matchTrailingSuffix(words.join(" "))
	if (!trail || words.length < 2) return null
	const suffix = trail.canonical
	const name = words.slice(0, -1).join(" ")
	if (!name || isSuffixOrDirectional(name)) return null
	return { prefix, name, suffix }
}

/** Render the affix-split street in random surface forms (abbrev vs expanded per affix), Title-cased. */
function renderStreet(random, parsed) {
	const name = title(parsed.name)
	const parts = []
	const components = { street: name }

	// Prefix: natural (from parse) or injected onto a prefix-less street to boost street_prefix signal.
	let prefix = parsed.prefix
	if (!prefix && random() < INJECT_PREFIX_PROB) {
		const m = lookupDirectional(DIRECTIONAL_ABBRS[Math.floor(random() * DIRECTIONAL_ABBRS.length)])
		prefix = { canonical: m.directional, abbreviation: m.abbreviation }
	}
	if (prefix) {
		const rendered = renderDirectional(prefix, random() < 0.5 ? "abbr" : "full", "Aa") // "Aa" → Title-case
		components.street_prefix = rendered
		parts.push(rendered)
	}

	parts.push(name)

	// Suffix: abbreviated ("St") vs expanded ("Street"), Title-cased to match the name.
	const full = title(parsed.suffix) // canonical is uppercase word → "Street"
	const abbr = matchCase(US_STREET_SUFFIX_PREFERRED_ABBR[parsed.suffix], "Aa") // "AVE" → "Ave"
	const renderedSuffix = random() < 0.5 ? abbr : full
	components.street_suffix = renderedSuffix
	parts.push(renderedSuffix)

	return { street: parts.join(" "), components }
}

/** Synthetic recipient/venue prefixes — the arena's "JOHN DOE, ACME INC, …" pattern. */
const VENUES = ["John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Maria Garcia", "Riverside Clinic"]

const tail = (loc, reg, pc) => (pc ? `${loc}, ${reg} ${pc}` : `${loc}, ${reg}`)

/**
 * Embed the rendered street in a RANDOM layout so the model recognizes affixes wherever the street
 * sits: full address, bare house+street, street-only (pure affix parse), or venue-prefixed.
 */
function renderRow(random, base, street, streetComponents) {
	const hn = base.house_number,
		loc = base.locality,
		reg = base.region,
		pc = base.postcode
	const road = `${hn} ${street}`
	const withRoad = { house_number: hn, ...streetComponents }
	const r = random()
	if (r < 0.4)
		return {
			fmt: "full",
			raw: `${road}, ${tail(loc, reg, pc)}`,
			components: { ...withRoad, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) },
		}
	if (r < 0.65) return { fmt: "bare", raw: road, components: withRoad }
	if (r < 0.85) return { fmt: "street-only", raw: street, components: { ...streetComponents } }
	const v = VENUES[Math.floor(random() * VENUES.length)]
	return {
		fmt: "venue",
		raw: `${v}, ${road}, ${tail(loc, reg, pc)}`,
		components: { venue: v, ...withRoad, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) },
	}
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
	let emitted = 0,
		skipped = 0,
		noAffix = 0,
		guard = 0
	const formatCounts = {}
	const affixCounts = { prefix: 0, suffix: 0, both: 0 }
	const N = pool.length
	while (emitted < opts.count && guard++ < opts.count * 10) {
		const base = pool[Math.floor(random() * N)]
		const parsed = parseStreet(base.street)
		if (!parsed) {
			noAffix++
			continue
		}
		const { street, components: streetComponents } = renderStreet(random, parsed)
		const { fmt, raw, components } = renderRow(random, base, street, streetComponents)
		// Every affix surface form must survive verbatim in raw, else alignment can't label it.
		const surfaces = [streetComponents.street_prefix, streetComponents.street, streetComponents.street_suffix].filter(
			Boolean
		)
		if (!surfaces.every((s) => raw.includes(s))) {
			skipped++
			continue
		}
		formatCounts[fmt] = (formatCounts[fmt] ?? 0) + 1
		const hasP = !!streetComponents.street_prefix
		if (hasP && streetComponents.street_suffix) affixCounts.both++
		else if (hasP) affixCounts.prefix++
		else affixCounts.suffix++

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
			license: "OpenAddresses US (non-VT) skeletons, street split via USPS Pub-28 C1/C2 (codex)",
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}
		outStream.write(JSON.stringify({ ...aligned.row, synth_method: "affix", synth_base_id: null }) + "\n")
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(
		`Done: emitted ${emitted} affix rows, skipped ${skipped}, no-affix ${noAffix} (pool ${pool.length}). → ${opts.output}\n` +
			`  formats: ${JSON.stringify(formatCounts)}\n` +
			`  affix mix: ${JSON.stringify(affixCounts)}`
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
