#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the MULTI-LOCALE country-coverage shard (the v0-parity `country` gap — ~27% F1, #452).
 *   Real OA skeletons across US/DE/FR/ES/IT/NL with a country token APPENDED in a varied surface form
 *   (canonical English name vs endonym vs ISO code — "United States"/"USA"/"US", "Germany"/
 *   "Deutschland"/"DE") via the @mailwoman/codex/country surface-form table. Two wins in one shard:
 *   (1) raises `country` prevalence so the tag stops collapsing; (2) the non-US rows add DE/FR/etc.
 *   exposure that RECOVERS the FR-postcode dilution the US-only affix shard introduced (#462).
 *
 *   Renders per-locale order (US: number-street, city, region postcode; EU: street-number, postcode
 *   city) so the country token sits where it really does — trailing — without disturbing the native
 *   order the base corpus trained on. Aligns to BIO, writes labeled JSONL.
 *
 *   The trustworthy gate is data/eval/external/country-real.jsonl (curated real addresses w/ country
 *   tokens, varied forms); --golden emits a held-out synthetic val. Mirrors build-affix/unit-shard.
 */

import { spawnSync } from "node:child_process"
import { createWriteStream } from "node:fs"

import { countrySurfaceForms } from "@mailwoman/codex/country"
import { alignRow, stableSourceId } from "@mailwoman/corpus"

// Multi-locale OA sources. region = implied admin where the extract is single-region (US states,
// DE Saxony/Berlin); countrywide extracts (FR/ES/IT/NL) read region from the CSV when present.
const SOURCES = [
	{ zip: "/tmp/oa-cache/us__ia__statewide.zip", csv: "us/ia/statewide.csv", iso2: "US", region: "IA", order: "us" },
	{ zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv", iso2: "US", region: "IL", order: "us" },
	{ zip: "/tmp/oa-cache/us__mt__statewide.zip", csv: "us/mt/statewide.csv", iso2: "US", region: "MT", order: "us" },
	{ zip: "/tmp/oa-cache/us__sd__statewide.zip", csv: "us/sd/statewide.csv", iso2: "US", region: "SD", order: "us" },
	{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv", iso2: "DE", region: "", order: "eu" },
	{ zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv", iso2: "FR", region: "", order: "eu" },
	// ES (es_addresses.csv) uses the Spanish IGN schema (nombre_via/numero/municipio), not the OA
	// standard columns — skipped here; the codex still recognizes "España"/"Spain" for matching. A
	// dedicated IGN adapter is a follow-up.
	{ zip: "/tmp/oa-cache/it__countrywide.zip", csv: "it/countrywide.csv", iso2: "IT", region: "", order: "eu" },
	{ zip: "/tmp/oa-cache/nl__countrywide.zip", csv: "nl/countrywide.csv", iso2: "NL", region: "", order: "eu" },
]
// Held-out for --golden: Vermont (US holdout) + Berlin (DE holdout) — geographic split, never trained.
const EVAL_SOURCES = [
	{ zip: "/tmp/oa-cache/us__vt__statewide.zip", csv: "us/vt/statewide.csv", iso2: "US", region: "VT", order: "us" },
	{ zip: "/tmp/oa-cache/de__berlin.zip", csv: "de/berlin.csv", iso2: "DE", region: "", order: "eu" },
]

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 50000, seed: 42, source: "synth-country", golden: false }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--golden") out.golden = true
	}
	if (!out.output) {
		console.error("Usage: build-country-shard.mjs --output <labeled.jsonl> [--count N] [--seed N] [--golden]")
		process.exit(1)
	}
	return out
}

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

function splitCsv(line) {
	const out = []
	let cur = "",
		inQ = false
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

function readTuples(source, limit) {
	// countrywide extracts (FR/ES/IT/NL) are GB-scale — reading the whole CSV blows V8's string limit.
	// We only need `limit` tuples, so cap the bytes with `head` (read ~8 lines per wanted tuple to
	// survive dedup/skips). Keeps the toString under the limit and the build fast.
	const maxLines = Math.max(limit * 8, 20000) + 1
	const r = spawnSync("bash", ["-c", `unzip -p "${source.zip}" "${source.csv}" | head -n ${maxLines}`], {
		maxBuffer: 1024 * 1024 * 1024,
		encoding: "buffer",
	})
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)
		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return []
	const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase())
	const idx = (n) => header.indexOf(n)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iRegion = idx("region"),
		iPost = idx("postcode")
	const get = (cells, i) => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples = []
	const seen = new Set()
	for (let li = 1; li < lines.length && tuples.length < limit; li++) {
		if (!lines[li]) continue
		const cells = splitCsv(lines[li])
		const street = get(cells, iStreet),
			locality = get(cells, iCity),
			house_number = get(cells, iNum)
		if (!street || !locality || !house_number) continue
		const key = `${house_number}|${street}|${locality}`.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({
			house_number,
			street,
			locality,
			region: get(cells, iRegion) || source.region,
			postcode: get(cells, iPost),
			iso2: source.iso2,
			order: source.order,
		})
	}
	return tuples
}

/** Pick a country surface form: 50% canonical English (first), 50% a random variant (endonym/code). */
function pickCountry(random, iso2) {
	const forms = countrySurfaceForms(iso2)
	if (forms.length === 0) return null
	if (random() < 0.5) return forms[0]
	return forms[1 + Math.floor(random() * (forms.length - 1))] ?? forms[0]
}

/** Render the address body in native-ish order with the country appended, plus a few layouts. */
function renderCountry(random, t, country) {
	const { house_number: hn, street, locality: loc, region: reg, postcode: pc, order } = t
	const components = { house_number: hn, street, locality: loc, country }
	if (reg) components.region = reg
	if (pc) components.postcode = pc
	let body
	if (order === "us") {
		const regPc = [reg, pc].filter(Boolean).join(" ")
		body = `${hn} ${street}, ${loc}${regPc ? ", " + regPc : ""}`
	} else {
		const pcCity = [pc, loc].filter(Boolean).join(" ")
		body = `${street} ${hn}, ${pcCity}`
	}
	const r = random()
	// country trailing (the real form), with separator variety; a fraction bare (no postcode/region).
	if (r < 0.8) return { fmt: "full", raw: `${body}, ${country}`, components }
	if (r < 0.92) return { fmt: "full-nl", raw: `${body}\n${country}`, components }
	// bare: street + city + country only
	const bareBody = order === "us" ? `${hn} ${street}, ${loc}` : `${street} ${hn}, ${loc}`
	return { fmt: "bare", raw: `${bareBody}, ${country}`, components: { house_number: hn, street, locality: loc, country } }
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)
	const sources = opts.golden ? EVAL_SOURCES : SOURCES
	const perSource = Math.ceil((opts.count * 3) / sources.length) // over-read; balance locales

	const pool = []
	const localeCounts = {}
	for (const s of sources) {
		const t = readTuples(s, perSource)
		console.error(`  ${s.csv} (${s.iso2}): ${t.length} tuples`)
		localeCounts[s.iso2] = (localeCounts[s.iso2] ?? 0) + t.length
		for (const x of t) pool.push(x)
	}
	if (pool.length === 0) {
		console.error("No tuples — are the cached OA zips present in /tmp/oa-cache?")
		process.exit(1)
	}

	const outStream = createWriteStream(opts.output, { encoding: "utf8" })
	let emitted = 0,
		skipped = 0,
		guard = 0
	const fmtCounts = {},
		isoCounts = {}
	const N = pool.length
	while (emitted < opts.count && guard++ < opts.count * 8) {
		const t = pool[Math.floor(random() * N)]
		const country = pickCountry(random, t.iso2)
		if (!country) {
			skipped++
			continue
		}
		const { fmt, raw, components } = renderCountry(random, t, country)
		if (!raw.includes(country)) {
			skipped++
			continue
		}
		fmtCounts[fmt] = (fmtCounts[fmt] ?? 0) + 1
		isoCounts[t.iso2] = (isoCounts[t.iso2] ?? 0) + 1
		const localeTag = t.iso2 === "US" ? "en-US" : `${t.iso2.toLowerCase()}-${t.iso2}`
		if (opts.golden) {
			outStream.write(JSON.stringify({ raw, components, country: t.iso2 }) + "\n")
			emitted++
			continue
		}
		const canonical = {
			raw,
			components,
			country: t.iso2,
			locale: localeTag,
			source: opts.source,
			source_id: stableSourceId(opts.source, components),
			corpus_version: "0.4.0",
			license: "OpenAddresses multi-locale skeletons + injected ISO-3166 country surface forms (codex)",
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}
		outStream.write(JSON.stringify({ ...aligned.row, synth_method: "country", synth_base_id: null }) + "\n")
		emitted++
	}
	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(
		`Done: emitted ${emitted} country rows, skipped ${skipped} (pool ${pool.length}). → ${opts.output}\n` +
			`  by locale: ${JSON.stringify(isoCounts)}\n  formats: ${JSON.stringify(fmtCounts)}`
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
