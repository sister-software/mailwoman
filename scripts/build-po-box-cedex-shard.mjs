#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the po_box / cedex coverage shard — the last starved-tag lever of the parity campaign (the
 *   unit-shard playbook applied to the two tags the corpus barely carries: `po_box` trains at ~0
 *   despite the codex matcher being P=R=100, and `cedex` has a single golden row and no training
 *   mass at all).
 *
 *   Surface vocabulary is NOT invented here (no-load-bearing-trivia): the US designators come from
 *   `@mailwoman/codex/us` (`US_PO_BOX_DESIGNATORS`, USPS Pub 28 §29) and every codex-covered US
 *   phrase must round-trip `isPOBox`; the non-US leaders come from the corpus
 *   `PO_BOX_LOCALE_TEMPLATES` (the DeepSeek-signed list in corpus/src/synthesize-po-box.ts);
 *   Canadian postcodes are synthesized to the `@mailwoman/codex/ca` pattern (valid FSA letter for
 *   the province via `FSA_LETTER_TO_PROVINCE`, validated with `normalizeCaPostalCode`). CEDEX is a
 *   single-word vocabulary (the SCHEMA.mdx example: `"CEDEX 08"` in `"75008 PARIS CEDEX 08"`) + an
 *   optional 1-2 digit suffix, per La Poste NF Z 10-011's last-line form.
 *
 *   Span convention (matches the golden eval + SCHEMA.mdx): the WHOLE designator+number phrase is the
 *   po_box span ("PO Box 123" → B-po_box I-po_box I-po_box), and "CEDEX 08" is the cedex span,
 *   SEPARATE from the postcode (cedex is a routing designation, not a postcode).
 *
 *   Classes (the #511 Montréal rows drove the CA-fr slice):
 *
 *   - Po-box-us: PO Box / P.O. Box / POB / Post Office Box / Box / Drawer / Caller / Lockbox onto real
 *       US OA (non-VT) locality/region/postcode tails — full, no-postcode, bare line-only,
 *       venue-prefixed, and USPS comma-less label layouts.
 *   - Pmb-us: street-addressed PMB / "#" rows ("100 Main St PMB 200, …") on real OA street skeletons.
 *   - Bp-fr: BP / B.P. / Boîte Postale onto real FR OA (BAN-derived) locality+postcode tails, including
 *       the institutional BP+CEDEX combo line ("BP 42, 75008 PARIS CEDEX 08").
 *   - Cedex-fr: CEDEX last-lines — line-only ("75008 PARIS CEDEX 08"), full street address, the
 *       golden-eval token order ("75008 CEDEX 08 Paris"), and venue-prefixed institutional rows.
 *   - Cp-ca-fr: Case Postale / CP / C.P. with Québec localities (GeoNames CA, CC-BY) and codex-valid
 *       G/H/J postcodes — covers both the golden order ("CP 1500, H2X 3V4 Montréal, QC") and the
 *       Canada-Post-native order ("CP 1500, Montréal QC H2X 3V4").
 *   - Po-box-ca-en: the en-CA mirror (Ontario localities, K/L/M/N/P postcodes).
 *
 *   LEAKAGE-SAFE EVAL (`--golden`): US rows use the VERMONT source only (the corpus defaultHoldout);
 *   FR and CA rows use a stable locality-hash holdout (hash%10==0 is golden-only, train gets the
 *   rest) and a different seed. Golden mode emits {raw, components, country} for per-locale-f1.
 *
 *   Prerequisites: the cached OA zips in /tmp/oa-cache (same set the unit/affix builders read) and
 *   the GeoNames Canada dump at /tmp/geonames-cache/CA.zip (curl -o /tmp/geonames-cache/CA.zip
 *   https://download.geonames.org/export/dump/CA.zip).
 *
 *   Pipeline (mirrors build-street-affix-shard.mjs): node scripts/build-po-box-cedex-shard.mjs
 *   --output /tmp/po-box-shard/po-box-cedex-train.jsonl --count 50000 --seed 42 node
 *   scripts/build-po-box-cedex-shard.mjs --output /tmp/po-box-shard/po-box-cedex-val.jsonl --golden
 *   --count 2000 --seed 99 python3 scripts/jsonl-to-parquet.py --input
 *   /tmp/po-box-shard/po-box-cedex-train.jsonl --output
 *   /tmp/po-box-shard/part-po-box-cedex-train.parquet
 */

import { spawnSync } from "node:child_process"
import { createWriteStream } from "node:fs"

import { FSA_LETTER_TO_PROVINCE, normalizeCaPostalCode } from "@mailwoman/codex/ca"
import { isPOBox } from "@mailwoman/codex/us"
import { alignRow, maybeNoisifyBoxNumber, PO_BOX_LOCALE_TEMPLATES, stableSourceId } from "@mailwoman/corpus"

// ── Base-skeleton sources ────────────────────────────────────────────────────────────────────────
// Same OA cache as the unit/affix shards. US train = every NON-Vermont state; US eval = Vermont
// (the corpus defaultHoldout). FR comes from the BAN-derived countrywide extract (stride-sampled —
// the file is 2.5 GB and insee-ordered, so a head-only read would be all département 01).
const US_TRAIN_SOURCES = [
	{ zip: "/tmp/oa-cache/us__ca__berkeley.zip", csv: "us/ca/berkeley.csv", region: "CA" },
	{ zip: "/tmp/oa-cache/us__ca__marin.zip", csv: "us/ca/marin.csv", region: "CA" },
	{ zip: "/tmp/oa-cache/us__dc__statewide.zip", csv: "us/dc/statewide.csv", region: "DC" },
	{ zip: "/tmp/oa-cache/us__ia__statewide.zip", csv: "us/ia/statewide.csv", region: "IA" },
	{ zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv", region: "IL" },
	{ zip: "/tmp/oa-cache/us__mt__statewide.zip", csv: "us/mt/statewide.csv", region: "MT" },
	{ zip: "/tmp/oa-cache/us__sd__statewide.zip", csv: "us/sd/statewide.csv", region: "SD" },
]
const US_EVAL_SOURCE = { zip: "/tmp/oa-cache/us__vt__statewide.zip", csv: "us/vt/statewide.csv", region: "VT" }
const FR_SOURCE = { zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv" }
const GEONAMES_CA = "/tmp/geonames-cache/CA.zip"

// ── Surface vocabulary (codex + corpus templates — see the header) ──────────────────────────────
const T = Object.fromEntries(PO_BOX_LOCALE_TEMPLATES.map((t) => [t.locale, t]))
// US: the corpus en-US leaders carry the common mass; the codex-only USPS Pub-28 designators
// (Caller/Drawer/Lockbox — firm-holdout and rural forms) ride at low weight. "Box" is in both.
const US_LEADERS_COMMON = T["en-US"].leaders // PO Box, P.O. Box, P.O.Box, PO BOX, POB, Post Office Box, Box
const US_LEADERS_RARE = ["Caller", "Firm Caller", "Drawer", "Lockbox"] // codex US_PO_BOX_DESIGNATORS tail
// "#" EXCLUDED (v4.4.0 probe finding): bare "#N" is a secondary-unit designator per USPS Pub 28
// and the shipped unit lever labels it `unit` — the corpus template's po_box reading CONTRADICTS
// a shipped convention (the #511 disease class, cross-shard). The probe measured the collision:
// the model parses "#389" as unit (correctly) and the shard's po_box gold failed it. PMB stays —
// it is a genuine commercial-mail-receiving designator with no unit collision.
const US_PMB_LEADERS = T["en-US"].pmb.filter((l) => l !== "#") // PMB
const FR_LEADERS = T["fr-FR"].leaders // BP, B.P., Boîte Postale, BP.
const CA_FR_LEADERS = T["fr-CA"].leaders // CP, C.P., Case Postale, BP, B.P.
const CA_EN_LEADERS = T["en-CA"].leaders // PO Box, P.O. Box, POB, Post Office Box

// Canadian postcode synthesis: valid first letters per province from the codex FSA prior, interior
// letters per the codex pattern (excludes the visually ambiguous D F I O Q U). The LDU digits are
// random — the SHAPE is the training signal, not the (unknowable) live assignment.
const QC_FSA_LETTERS = Object.entries(FSA_LETTER_TO_PROVINCE)
	.filter(([, p]) => p === "QC")
	.map(([l]) => l) // G H J
const ON_FSA_LETTERS = Object.entries(FSA_LETTER_TO_PROVINCE)
	.filter(([, p]) => p === "ON")
	.map(([l]) => l) // K L M N P
const CA_INTERIOR_LETTERS = "ABCEGHJKLMNPRSTVWXYZ"

// Class mix — po_box mass leans US (the production arena), cedex gets a real block, and the CA-fr
// class exists because the #511 Montréal rows ("Case Postale 200, H3A 1B9 Montréal, QC") fail today.
const CLASS_MIX = [
	["po-box-us", 0.4],
	["pmb-us", 0.08],
	["bp-fr", 0.12],
	["cedex-fr", 0.2],
	["cp-ca-fr", 0.15],
	["po-box-ca-en", 0.05],
]

/** Synthetic recipient/venue prefixes — the arena's "JOHN DOE, ACME INC, …" pattern. */
const VENUES_EN = ["John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Maria Garcia", "Riverside Clinic"]
const VENUES_FR = ["Société Dupont", "Cabinet Martin", "Hôpital Central", "Mairie Annexe", "Imprimerie Moderne"]

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 50000, seed: 42, source: "synth-po-box-cedex", golden: false }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--golden") out.golden = true
	}
	if (!out.output) {
		console.error("Usage: build-po-box-cedex-shard.mjs --output <labeled.jsonl> [--count N] [--seed N] [--golden]")
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

/** Stable locality hash for the FR/CA train↔golden split (djb2; hash%10===0 → golden-only). */
function localityHash(name) {
	let h = 5381
	const s = name.toLowerCase()
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
	return h
}
const isHoldoutLocality = (name) => localityHash(name) % 10 === 0

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

const cleanLocality = (loc) => loc && loc.length <= 40 && !/\d|,/.test(loc) && !/cedex/i.test(loc)

/** Stream real US tuples (number/street/city/postcode) out of a cached OA zip. */
function readUsTuples(source) {
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
		const locality = get(cells, iCity)
		if (!cleanLocality(locality)) continue
		const key = locality.toLowerCase()
		const street = get(cells, iStreet),
			house_number = get(cells, iNum)
		// One tuple per (locality, street) pair keeps the pool varied without ballooning memory.
		const pairKey = `${key}|${street}`.toLowerCase()
		if (seen.has(pairKey)) continue
		seen.add(pairKey)
		tuples.push({ house_number, street, locality, region: source.region, postcode: get(cells, iPost) })
	}
	return tuples
}

/**
 * Stride-sampled FR tuples (number/street/city/postcode). The countrywide CSV is 2.5 GB and
 * insee-ordered; `awk NR%K` strides the whole country instead of reading one département. Quoted
 * commas survive because awk only FILTERS lines — parsing stays in splitCsv.
 */
function readFrTuples(limit) {
	const r = spawnSync(
		"bash",
		["-c", `unzip -p "${FR_SOURCE.zip}" "${FR_SOURCE.csv}" | awk 'NR==1 || NR%211==3' | head -n ${limit + 1}`],
		{ maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }
	)
	if (r.status !== 0 && r.stdout.length === 0) {
		console.error(`  WARN: unzip failed for ${FR_SOURCE.zip}`)
		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return []
	const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase())
	const idx = (n) => header.indexOf(n)
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
		const locality = get(cells, iCity),
			postcode = get(cells, iPost),
			street = get(cells, iStreet),
			house_number = get(cells, iNum)
		if (!cleanLocality(locality) || !/^\d{5}$/.test(postcode) || !street || !house_number) continue
		const key = `${locality}|${street}`.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({ house_number, street, locality, postcode })
	}
	return tuples
}

/**
 * Canadian locality pools from the GeoNames dump (CC-BY 4.0): feature class P, admin1 10 (Québec) /
 * 08 (Ontario), population > 1000. GeoNames is the provenance-tracked source — no hand list.
 */
function readCaLocalities(admin1) {
	const r = spawnSync(
		"bash",
		[
			"-c",
			`unzip -p "${GEONAMES_CA}" CA.txt | awk -F'\\t' '$7=="P" && $9=="CA" && $11=="${admin1}" && $15>1000 {print $2}'`,
		],
		{ maxBuffer: 1024 * 1024 * 256, encoding: "utf8" }
	)
	if (r.status !== 0) {
		console.error(`  WARN: GeoNames read failed (admin1=${admin1}) — is ${GEONAMES_CA} present?`)
		return []
	}
	return [...new Set(r.stdout.split("\n").filter(cleanLocality))]
}

// ── Rendering helpers ────────────────────────────────────────────────────────────────────────────

/** Box-number distribution (mirrors the corpus defaultPickNumber bands: 70% are 1-3 digits). */
function pickBoxNumber(random) {
	const r = random()
	if (r < 0.3) return String(1 + Math.floor(random() * 99))
	if (r < 0.7) return String(100 + Math.floor(random() * 900))
	if (r < 0.95) return String(1000 + Math.floor(random() * 9000))
	return String(10000 + Math.floor(random() * 90000))
}

/** Case dial for the designator phrase: mostly template casing, sometimes UPPER, rarely lower. */
function caseDial(random, s) {
	const r = random()
	if (r < 0.7) return s
	if (r < 0.92) return s.toUpperCase()
	return s.toLowerCase()
}

// Leaders the codex PO_BOX_RE genuinely covers (everything en-US except "POB"; PMB/"#" are the
// corpus's CMRA forms, outside USPS Pub-28 §29). Used to scope the isPOBox round-trip assertion.
const CODEX_COVERED_LEADERS = new Set(
	["PO Box", "P.O. Box", "P.O.Box", "PO BOX", "Post Office Box", "Box", ...US_LEADERS_RARE].map((l) => l.toLowerCase())
)

/** Compose a po_box phrase. "#" joins without a space ("#500", the golden PMB variant). */
function makePoBoxPhrase(random, leaders, rareLeaders) {
	let leader = leaders[Math.floor(random() * leaders.length)]
	if (rareLeaders && random() < 0.1) leader = rareLeaders[Math.floor(random() * rareLeaders.length)]
	const num = maybeNoisifyBoxNumber(pickBoxNumber(random), random)
	const phrase = leader === "#" ? `#${num}` : `${caseDial(random, leader)} ${num}`
	// Codex round-trip: a phrase built from a codex-known designator and a clean id must satisfy the
	// matcher (the noisy ids — commas/spaces — are corpus-designed adversarial forms the regex
	// rightly rejects, so they're exempt). A failure here is a generation bug; fail loud.
	if (CODEX_COVERED_LEADERS.has(leader.toLowerCase()) && /^[\dA-Za-z][\dA-Za-z-]*$/.test(num) && !isPOBox(phrase)) {
		throw new Error(`generated a po_box phrase the codex matcher rejects: "${phrase}"`)
	}
	return phrase
}

/** A CEDEX designation: "CEDEX 08" / "Cedex 8" / bare "CEDEX" (the SCHEMA.mdx / NF Z 10-011 form). */
function makeCedex(random) {
	const r = random()
	const word = r < 0.6 ? "CEDEX" : r < 0.9 ? "Cedex" : "cedex"
	if (random() < 0.2) return word // "33077 BORDEAUX CEDEX" — un-numbered offices are common
	const n = 1 + Math.floor(random() * 20)
	const id = random() < 0.5 ? String(n).padStart(2, "0") : String(n)
	return `${word} ${id}`
}

/** Synthesize a codex-valid Canadian postcode for a province's FSA letters ("H2X 3V4"). */
function makeCaPostcode(random, fsaLetters) {
	const L = () => CA_INTERIOR_LETTERS[Math.floor(random() * CA_INTERIOR_LETTERS.length)]
	const D = () => String(Math.floor(random() * 10))
	const first = fsaLetters[Math.floor(random() * fsaLetters.length)]
	const pc = `${first}${D()}${L()} ${D()}${L()}${D()}`
	// The codex pattern is the contract — a generation bug should fail loud, not emit junk labels.
	if (!normalizeCaPostalCode(pc)) throw new Error(`generated an invalid CA postcode: ${pc}`)
	return pc
}

const pick = (random, arr) => arr[Math.floor(random() * arr.length)]

// ── Per-class renderers — each returns { fmt, raw, components } ──────────────────────────────────

function renderPoBoxUs(random, t) {
	const phrase = makePoBoxPhrase(random, US_LEADERS_COMMON, US_LEADERS_RARE)
	const { locality: loc, region: reg, postcode: pc } = t
	const base = { po_box: phrase, locality: loc, region: reg }
	const r = random()
	if (r < 0.4 && pc)
		return { fmt: "full", raw: `${phrase}, ${loc}, ${reg} ${pc}`, components: { ...base, postcode: pc } }
	if (r < 0.55) return { fmt: "no-postcode", raw: `${phrase}, ${loc}, ${reg}`, components: base }
	if (r < 0.75) return { fmt: "bare", raw: phrase, components: { po_box: phrase } }
	if (r < 0.9) {
		const v = pick(random, VENUES_EN)
		return {
			fmt: "venue",
			raw: pc ? `${v}, ${phrase}, ${loc}, ${reg} ${pc}` : `${v}, ${phrase}, ${loc}, ${reg}`,
			components: { venue: v, ...base, ...(pc ? { postcode: pc } : {}) },
		}
	}
	// USPS label form: comma-less, all-caps ("PO BOX 123 BURLINGTON VT 05401").
	const up = (s) => s.toUpperCase()
	return {
		fmt: "label-nocomma",
		raw: pc ? `${up(phrase)} ${up(loc)} ${reg} ${pc}` : `${up(phrase)} ${up(loc)} ${reg}`,
		components: { po_box: up(phrase), locality: up(loc), region: reg, ...(pc ? { postcode: pc } : {}) },
	}
}

function renderPmbUs(random, t) {
	const phrase = makePoBoxPhrase(random, US_PMB_LEADERS)
	const { house_number: hn, street, locality: loc, region: reg, postcode: pc } = t
	const road = `${hn} ${street}`
	const components = { house_number: hn, street, po_box: phrase, locality: loc, region: reg, postcode: pc }
	const r = random()
	if (r < 0.5) return { fmt: "pmb-after-street", raw: `${road} ${phrase}, ${loc}, ${reg} ${pc}`, components }
	if (r < 0.85) return { fmt: "pmb-comma", raw: `${road}, ${phrase}, ${loc}, ${reg} ${pc}`, components }
	return { fmt: "pmb-bare", raw: `${road} ${phrase}`, components: { house_number: hn, street, po_box: phrase } }
}

function renderBpFr(random, t) {
	const phrase = makePoBoxPhrase(random, FR_LEADERS)
	const { locality, postcode: pc } = t
	const upper = random() < 0.5
	const loc = upper ? locality.toUpperCase() : locality
	const r = random()
	if (r < 0.45)
		return {
			fmt: "bp-tail",
			raw: `${phrase}, ${pc} ${loc}`,
			components: { po_box: phrase, postcode: pc, locality: loc },
		}
	if (r < 0.6) return { fmt: "bp-bare", raw: phrase, components: { po_box: phrase } }
	if (r < 0.8) {
		// The institutional combo line — a BP and a CEDEX routing on the same last line.
		const cedex = makeCedex(random)
		const locUp = locality.toUpperCase()
		return {
			fmt: "bp-cedex",
			raw: `${phrase}, ${pc} ${locUp} ${cedex}`,
			components: { po_box: phrase, postcode: pc, locality: locUp, cedex },
		}
	}
	const v = pick(random, VENUES_FR)
	return {
		fmt: "bp-venue",
		raw: `${v}, ${phrase}, ${pc} ${loc}`,
		components: { venue: v, po_box: phrase, postcode: pc, locality: loc },
	}
}

function renderCedexFr(random, t) {
	const cedex = makeCedex(random)
	const { house_number: hn, street, locality, postcode: pc } = t
	const loc = random() < 0.6 ? locality.toUpperCase() : locality
	const line = { postcode: pc, locality: loc, cedex }
	const r = random()
	if (r < 0.4) return { fmt: "cedex-line", raw: `${pc} ${loc} ${cedex}`, components: line }
	if (r < 0.75)
		return {
			fmt: "cedex-full",
			raw: `${hn} ${street}, ${pc} ${loc} ${cedex}`,
			components: { house_number: hn, street, ...line },
		}
	if (r < 0.85) return { fmt: "cedex-golden-order", raw: `${pc} ${cedex} ${loc}`, components: line }
	const v = pick(random, VENUES_FR)
	return { fmt: "cedex-venue", raw: `${v}, ${pc} ${loc} ${cedex}`, components: { venue: v, ...line } }
}

function renderCaFr(random, loc) {
	const phrase = makePoBoxPhrase(random, CA_FR_LEADERS)
	const pc = makeCaPostcode(random, QC_FSA_LETTERS)
	const components = { po_box: phrase, postcode: pc, locality: loc, region: "QC" }
	const r = random()
	// The #511 golden order: postcode BEFORE locality, region trailing.
	if (r < 0.4) return { fmt: "ca-fr-golden-order", raw: `${phrase}, ${pc} ${loc}, QC`, components }
	if (r < 0.7) return { fmt: "ca-fr-native", raw: `${phrase}, ${loc} QC ${pc}`, components }
	if (r < 0.85) return { fmt: "ca-fr-bare", raw: phrase, components: { po_box: phrase } }
	const v = pick(random, VENUES_FR)
	return { fmt: "ca-fr-venue", raw: `${v}, ${phrase}, ${loc} QC ${pc}`, components: { venue: v, ...components } }
}

function renderCaEn(random, loc) {
	const phrase = makePoBoxPhrase(random, CA_EN_LEADERS)
	const pc = makeCaPostcode(random, ON_FSA_LETTERS)
	const components = { po_box: phrase, locality: loc, region: "ON", postcode: pc }
	const r = random()
	if (r < 0.5) return { fmt: "ca-en-standard", raw: `${phrase}, ${loc}, ON ${pc}`, components }
	if (r < 0.8) return { fmt: "ca-en-golden-order", raw: `${phrase}, ${pc} ${loc}, ON`, components }
	return { fmt: "ca-en-bare", raw: phrase, components: { po_box: phrase } }
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Order components so short, collision-prone needles (2-letter regions) are located AFTER the long
 * anchored ones — alignRow claims spans greedily in insertion order, and a leading "on" inside
 * "London" must already be claimed by `locality` before `region: "ON"` goes looking.
 */
const COMPONENT_ORDER = ["house_number", "street", "po_box", "venue", "locality", "postcode", "region", "cedex"]
function orderComponents(components) {
	const out = {}
	for (const k of COMPONENT_ORDER) if (components[k]) out[k] = components[k]
	return out
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)

	// US pool: VT only for golden, non-VT for train (the established geographic holdout).
	const usPool = []
	for (const s of opts.golden ? [US_EVAL_SOURCE] : US_TRAIN_SOURCES) {
		const t = readUsTuples(s)
		console.error(`  ${s.csv}: ${t.length} tuples`)
		for (const x of t) usPool.push(x)
	}
	// FR + CA pools: stable locality-hash holdout (golden gets hash%10==0, train the rest).
	const frAll = readFrTuples(80000)
	const frPool = frAll.filter((t) => isHoldoutLocality(t.locality) === opts.golden)
	console.error(`  ${FR_SOURCE.csv}: ${frAll.length} tuples (${frPool.length} after holdout split)`)
	const qcAll = readCaLocalities("10")
	const onAll = readCaLocalities("08")
	const qcPool = qcAll.filter((l) => isHoldoutLocality(l) === opts.golden)
	const onPool = onAll.filter((l) => isHoldoutLocality(l) === opts.golden)
	console.error(`  GeoNames CA: QC ${qcAll.length}→${qcPool.length}, ON ${onAll.length}→${onPool.length}`)
	if (usPool.length === 0 || frPool.length === 0 || qcPool.length === 0 || onPool.length === 0) {
		console.error("A base pool is empty — check /tmp/oa-cache and /tmp/geonames-cache/CA.zip.")
		process.exit(1)
	}

	const pickClass = (r) => {
		let acc = 0
		for (const [name, w] of CLASS_MIX) {
			acc += w
			if (r < acc) return name
		}
		return CLASS_MIX[CLASS_MIX.length - 1][0]
	}

	const outStream = createWriteStream(opts.output, { encoding: "utf8" })
	let emitted = 0,
		skipped = 0,
		guard = 0
	const classCounts = {},
		formatCounts = {},
		leaderCounts = {}
	while (emitted < opts.count && guard++ < opts.count * 10) {
		const cls = pickClass(random())
		let rendered, country, locale
		if (cls === "po-box-us") {
			rendered = renderPoBoxUs(random, pick(random, usPool))
			country = "US"
			locale = "en-US"
		} else if (cls === "pmb-us") {
			const t = pick(random, usPool)
			if (!t.postcode || !t.street || !t.house_number) continue
			rendered = renderPmbUs(random, t)
			country = "US"
			locale = "en-US"
		} else if (cls === "bp-fr") {
			rendered = renderBpFr(random, pick(random, frPool))
			country = "FR"
			locale = "fr-FR"
		} else if (cls === "cedex-fr") {
			rendered = renderCedexFr(random, pick(random, frPool))
			country = "FR"
			locale = "fr-FR"
		} else if (cls === "cp-ca-fr") {
			rendered = renderCaFr(random, pick(random, qcPool))
			country = "CA"
			locale = "fr-CA"
		} else {
			rendered = renderCaEn(random, pick(random, onPool))
			country = "CA"
			locale = "en-CA"
		}
		const { fmt, raw, components } = rendered
		// Every component surface must survive verbatim in raw, else alignment can't label it.
		if (!Object.values(components).every((s) => raw.includes(s))) {
			skipped++
			continue
		}
		classCounts[cls] = (classCounts[cls] ?? 0) + 1
		formatCounts[fmt] = (formatCounts[fmt] ?? 0) + 1
		if (components.po_box) {
			const head = components.po_box.split(/\s+/)[0].replace(/\d+$/, "#")
			leaderCounts[head.toLowerCase()] = (leaderCounts[head.toLowerCase()] ?? 0) + 1
		}

		if (opts.golden) {
			outStream.write(JSON.stringify({ raw, components: orderComponents(components), country }) + "\n")
			emitted++
			continue
		}
		const canonical = {
			raw,
			components: orderComponents(components),
			country,
			locale,
			source: opts.source,
			source_id: stableSourceId(opts.source, components),
			corpus_version: "0.4.0",
			license:
				country === "CA"
					? "GeoNames CA (CC-BY 4.0) locality skeletons + Canada Post box forms (corpus templates); postcodes synthesized to the codex CA pattern"
					: country === "FR"
						? "OpenAddresses FR (BAN-derived) skeletons + La Poste BP/CEDEX forms (corpus templates, NF Z 10-011)"
						: "OpenAddresses US (non-VT) skeletons + USPS Pub-28 §29 PO-box designators (codex/corpus templates)",
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}
		outStream.write(JSON.stringify({ ...aligned.row, synth_method: cls, synth_base_id: null }) + "\n")
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(
		`Done: emitted ${emitted} rows, skipped ${skipped}. → ${opts.output}\n` +
			`  classes: ${JSON.stringify(classCounts)}\n` +
			`  formats: ${JSON.stringify(formatCounts)}\n` +
			`  leaders: ${JSON.stringify(leaderCounts)}`
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
