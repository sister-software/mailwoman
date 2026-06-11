#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the BALANCED, MODEL-FIRST country-coverage shard (#464). The shipped v4.1.0 model is
 *   STARVED on `country` (P=R=F1=0 on the homograph eval — never emits it), so this fills a void
 *   the same way the `unit` shard did, but built to AVOID the night-9 over-fire (a
 *   trailing-country-only shard taught "trailing token ⇒ country"). Three ingredients:
 *
 *   1. Breadth/recall — real OA skeletons (US/DE/FR/IT/NL) with a country token in a varied surface form
 *        from @mailwoman/codex/country (canonical / endonym / ISO code), + ~30% country-ABSENT
 *        negatives (teach O-emission, the precision floor).
 *   2. Homograph CONTRAST pairs — the key addition. Each true country-name homograph (Georgia, Jordan,
 *        Lebanon, Mexico, Peru, Turkey) rendered BOTH ways: as `country` (foreign-city context) AND
 *        as the US `region`/`locality` (US ZIP context). Teaches that the label is CONTEXTUAL, not
 *        positional — the thing a deterministic lookup cannot do.
 *   3. Code-as-region negatives — 2-letter codes that are both a US state abbrev and an ISO country code
 *        (CA/GA/IN/MA/PA/AL) in US-ZIP context → must read as `region`, never `country`.
 *
 *   The trustworthy gate is data/eval/external/country-homograph-real.jsonl (curated, held-out);
 *   --golden emits a held-out synthetic val. Pair with class-weighted CRF loss at train time (the
 *   data keeps country prevalence realistic; the loss compensates). See
 *   docs/articles/plan/reference/closed-vocab-fields-model-first.mdx.
 */

import { spawnSync } from "node:child_process"
import { createWriteStream } from "node:fs"

import { COUNTRY_SURFACE_FORMS, CountryNames } from "@mailwoman/codex/country"
import { alignRow, stableSourceId } from "@mailwoman/corpus"

// v2: the country TOKEN is decoupled from the skeleton's locale and drawn from a BROAD pool — every
// ISO canonical name + every curated surface form (endonyms/abbrevs). v1 injected only the skeleton's
// own 5 locales (US/DE/FR/IT/NL) → the model never saw Canada/Switzerland/Japan/etc. and country-real
// recall stuck at 35% (P80). Appending "Japan" to a US skeleton is geographically fake but trains the
// TAG (trailing country name → country), exactly like the directional injection. Surface forms are
// over-weighted so endonyms/abbrevs ("Deutschland","USA","NL") get strong signal.
const COUNTRY_FORM_POOL = (() => {
	const surface = Object.values(COUNTRY_SURFACE_FORMS).flat() // endonyms + abbrevs + canonical (curated)
	const names = [...CountryNames] // all ~249 ISO canonical English names (breadth)
	return { surface, names }
})()
const COUNTRY_ABSENT_PROB = 0.3 // negatives: rows with NO country token → teach golden precision

// Multi-locale OA sources. region = implied admin where the extract is single-region (US states,
// DE Saxony/Berlin); countrywide extracts (FR/ES/IT/NL) read region from the CSV when present.
const SOURCES = [
	{ zip: "/tmp/oa-cache/us__ia__statewide.zip", csv: "us/ia/statewide.csv", iso2: "US", region: "IA", order: "us" },
	{ zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv", iso2: "US", region: "IL", order: "us" },
	{ zip: "/tmp/oa-cache/us__mt__statewide.zip", csv: "us/mt/statewide.csv", iso2: "US", region: "MT", order: "us" },
	{ zip: "/tmp/oa-cache/us__sd__statewide.zip", csv: "us/sd/statewide.csv", iso2: "US", region: "SD", order: "us" },
	{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv", iso2: "DE", region: "", order: "eu" },
	{ zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv", iso2: "FR", region: "", order: "fr" },
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

/** Pick a country token from the BROAD pool, or null (a country-absent negative). v2. */
function pickCountry(random) {
	if (random() < COUNTRY_ABSENT_PROB) return null // negative — teaches "trailing token != always country"
	// 60% curated surface forms (endonym/abbrev variety), 40% broad ISO canonical names (coverage).
	const pool = random() < 0.6 ? COUNTRY_FORM_POOL.surface : COUNTRY_FORM_POOL.names
	return pool[Math.floor(random() * pool.length)]
}

/** Render the address body in native-ish order. `country` null → a country-ABSENT negative row. */
function renderCountry(random, t, country) {
	const { house_number: hn, street, locality: loc, region: reg, postcode: pc, order } = t
	const components = { house_number: hn, street, locality: loc }
	if (reg) components.region = reg
	if (pc) components.postcode = pc
	let body
	if (order === "us") {
		const regPc = [reg, pc].filter(Boolean).join(" ")
		body = `${hn} ${street}, ${loc}${regPc ? ", " + regPc : ""}`
	} else if (order === "fr") {
		// French is NUMBER-street, postcode-city: "84 Route de la Fontaine, 75008 Paris".
		body = `${hn} ${street}, ${[pc, loc].filter(Boolean).join(" ")}`
	} else {
		// DE/IT/NL: street-number, postcode-city: "Pariser Platz 1, 10117 Berlin".
		const pcCity = [pc, loc].filter(Boolean).join(" ")
		body = `${street} ${hn}, ${pcCity}`
	}
	if (!country) {
		// Negative: a normal address, NO country token/component. Teaches the model that a trailing
		// region/city/postcode is NOT a country (counters the v1 golden over-firing, P23%).
		return { fmt: "negative", raw: body, components }
	}
	const withC = { ...components, country }
	const r = random()
	if (r < 0.8) return { fmt: "full", raw: `${body}, ${country}`, components: withC }
	if (r < 0.92) return { fmt: "full-nl", raw: `${body}\n${country}`, components: withC }
	const bareBody = order === "us" || order === "fr" ? `${hn} ${street}, ${loc}` : `${street} ${hn}, ${loc}`
	return {
		fmt: "bare",
		raw: `${bareBody}, ${country}`,
		components: { house_number: hn, street, locality: loc, country },
	}
}

// ── Homograph contrast (the model-first addition) ───────────────────────────────────────────────
// True country-name homographs: the surface form is BOTH a country AND a US state/locality. Rendering
// each BOTH ways (foreign-city → country; US-ZIP → region/locality) is what teaches the CONTEXTUAL
// distinction. role: how the surface reads in US context.
const HOMOGRAPHS = [
	{
		surface: "Georgia",
		iso2: "GE",
		cities: ["Tbilisi", "Batumi", "Kutaisi", "Rustavi"],
		us: { role: "region", locality: "Atlanta", region: "Georgia", postcodes: ["30309", "31401", "30601", "31201"] },
	},
	{
		surface: "Jordan",
		iso2: "JO",
		cities: ["Amman", "Irbid", "Zarqa", "Aqaba"],
		us: { role: "locality", locality: "Jordan", region: "MN", postcodes: ["55352"] },
	},
	{
		surface: "Lebanon",
		iso2: "LB",
		cities: ["Beirut", "Tripoli", "Sidon", "Byblos"],
		us: { role: "locality", locality: "Lebanon", region: "TN", postcodes: ["37087", "03766", "17042", "45036"] },
	},
	{
		surface: "Mexico",
		iso2: "MX",
		cities: ["Guadalajara", "Monterrey", "Puebla", "Oaxaca"],
		us: { role: "locality", locality: "Mexico", region: "MO", postcodes: ["65265"] },
	},
	{
		surface: "Peru",
		iso2: "PE",
		cities: ["Cusco", "Arequipa", "Trujillo", "Iquitos"],
		us: { role: "locality", locality: "Peru", region: "IL", postcodes: ["61354", "46970"] },
	},
	{
		surface: "Turkey",
		iso2: "TR",
		cities: ["Ankara", "Izmir", "Bursa", "Antalya"],
		us: { role: "locality", locality: "Turkey", region: "TX", postcodes: ["79261", "28393"] },
	},
]
// 2-letter codes that are BOTH a US state abbrev AND an ISO country code → must read as region in US ctx.
const ABBREV_REGIONS = [
	{ code: "CA", localities: ["Los Angeles", "Sacramento", "San Diego"], postcodes: ["90012", "95814", "92101"] }, // California / Canada
	{ code: "GA", localities: ["Atlanta", "Savannah", "Macon"], postcodes: ["30309", "31401", "31201"] }, // Georgia(US) / Georgia
	{ code: "IN", localities: ["Indianapolis", "Fort Wayne"], postcodes: ["46204", "46802"] }, // Indiana / India
	{ code: "MA", localities: ["Boston", "Worcester"], postcodes: ["02108", "01608"] }, // Massachusetts / Morocco
	{ code: "PA", localities: ["Philadelphia", "Pittsburgh"], postcodes: ["19103", "15222"] }, // Pennsylvania / Panama
	{ code: "AL", localities: ["Birmingham", "Montgomery"], postcodes: ["35203", "36104"] }, // Alabama / Albania
]
const STREET_POOL = [
	"Main Street",
	"Oak Avenue",
	"Park Road",
	"Elm Street",
	"Hill Road",
	"Market Street",
	"Church Street",
	"King Street",
	"2nd Avenue",
	"Maple Drive",
]
const pick = (random, arr) => arr[Math.floor(random() * arr.length)]
const houseNo = (random) => String(1 + Math.floor(random() * 998))

/**
 * A homograph CONTRAST row: ~half render the surface as `country` (foreign city), half as the US
 * `region`/`locality` (US ZIP, NO country). Returns iso2 for provenance.
 */
function renderHomograph(random) {
	const h = pick(random, HOMOGRAPHS)
	const hn = houseNo(random),
		street = pick(random, STREET_POOL)
	if (random() < 0.5) {
		const city = pick(random, h.cities)
		const withStreet = random() < 0.6
		const raw = withStreet ? `${hn} ${street}, ${city}, ${h.surface}` : `${city}, ${h.surface}`
		const components = withStreet
			? { house_number: hn, street, locality: city, country: h.surface }
			: { locality: city, country: h.surface }
		return { fmt: "homograph-country", raw, components, iso2: h.iso2 }
	}
	const pc = pick(random, h.us.postcodes)
	if (h.us.role === "region") {
		// surface is the US STATE: "123 Oak Ave, Atlanta, Georgia 30309" → region, no country
		return {
			fmt: "homograph-us-region",
			raw: `${hn} ${street}, ${h.us.locality}, ${h.surface} ${pc}`,
			components: { house_number: hn, street, locality: h.us.locality, region: h.surface, postcode: pc },
			iso2: "US",
		}
	}
	// surface is the US CITY: "123 Oak Ave, Lebanon, TN 37087" → locality, no country
	return {
		fmt: "homograph-us-locality",
		raw: `${hn} ${street}, ${h.surface}, ${h.us.region} ${pc}`,
		components: { house_number: hn, street, locality: h.surface, region: h.us.region, postcode: pc },
		iso2: "US",
	}
}

/** An abbrev-as-region negative: "123 Main St, Los Angeles, CA 90012" → region CA, NO country. */
function renderAbbrevRegion(random) {
	const a = pick(random, ABBREV_REGIONS)
	const hn = houseNo(random),
		street = pick(random, STREET_POOL),
		locality = pick(random, a.localities),
		postcode = pick(random, a.postcodes)
	return {
		fmt: "abbrev-region",
		raw: `${hn} ${street}, ${locality}, ${a.code} ${postcode}`,
		components: { house_number: hn, street, locality, region: a.code, postcode },
		iso2: "US",
	}
}

const HOMOGRAPH_FRAC = 0.22 // share of rows that are homograph contrast pairs
const ABBREV_FRAC = 0.08 // share that are code-as-region negatives (cumulative with HOMOGRAPH_FRAC)

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
		// Mix three row types: homograph contrast (the distinction), code-as-region negatives, and the
		// breadth/recall main path (random ISO form on an OA skeleton, ~30% country-absent).
		const roll = random()
		let rendered, rowIso2
		if (roll < HOMOGRAPH_FRAC) {
			rendered = renderHomograph(random)
			rowIso2 = rendered.iso2
		} else if (roll < HOMOGRAPH_FRAC + ABBREV_FRAC) {
			rendered = renderAbbrevRegion(random)
			rowIso2 = rendered.iso2
		} else {
			const t = pool[Math.floor(random() * N)]
			const country = pickCountry(random) // may be null → a country-absent negative row
			rendered = renderCountry(random, t, country)
			rowIso2 = t.iso2
			if (country && !rendered.raw.includes(country)) {
				skipped++
				continue
			}
		}
		const { fmt, raw, components } = rendered
		fmtCounts[fmt] = (fmtCounts[fmt] ?? 0) + 1
		isoCounts[rowIso2] = (isoCounts[rowIso2] ?? 0) + 1
		const localeTag = rowIso2 === "US" ? "en-US" : `${rowIso2.toLowerCase()}-${rowIso2}`
		if (opts.golden) {
			outStream.write(JSON.stringify({ raw, components, country: rowIso2 }) + "\n")
			emitted++
			continue
		}
		const canonical = {
			raw,
			components,
			country: rowIso2,
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
