/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `po-box-cedex` shard recipe — the po_box / cedex coverage lever of the parity campaign (the
 *   unit-shard playbook applied to the two starved tags `po_box` and `cedex`). Generate-mode,
 *   self-contained. Ported from scripts/build-po-box-cedex-shard.mjs.
 *
 *   Surface vocabulary is provenance-first: US designators come from `@mailwoman/codex/us`
 *   (`isPOBox`, USPS Pub 28 §29); non-US leaders from the corpus `PO_BOX_LOCALE_TEMPLATES`;
 *   Canadian postcodes are synthesized to the `@mailwoman/codex/ca` pattern; CEDEX rides
 *   `@mailwoman/codex/fr` (`isCedex`); AU/NZ delivery services round-trip
 *   `@mailwoman/codex/{au,nz}`. Span convention: the WHOLE designator+number phrase is the `po_box`
 *   span, and "CEDEX 08" is a SEPARATE `cedex` span.
 *
 *   Classes (CLASS_MIX): po-box-us, po-box-us-military (#517), pmb-us, bp-fr, cedex-fr, cp-ca-fr,
 *   po-box-ca-en, po-box-au (#517), po-box-nz (#517). `--golden` emits the leakage-safe holdout
 *   variant ({raw, components, country}); US golden = Vermont only, FR/CA/AU/NZ = a stable
 *   locality-hash holdout (hash%10===0).
 *
 *   Prerequisites (read once, before the generation loop — these do NOT consume `random`): the cached
 *   OA zips in /tmp/oa-cache, the GeoNames Canada dump at /tmp/geonames-cache/CA.zip, and the
 *   GeoNames POSTAL-CODE dumps for AU/NZ (/tmp/geonames-cache/{AU,NZ}-postal.zip). See the legacy
 *   script header for the exact curl commands.
 *
 *   Byte-fidelity: the legacy script seeded its own mulberry32 from `--seed`
 *   (`mulberry32(opts.seed)`); this recipe re-creates the SAME generator
 *   (`makeMulberry32(opts.seed)`) and preserves the synthesis call order exactly, so `--seed N`
 *   reproduces the legacy run byte-for-byte.
 */

import { spawnSync } from "node:child_process"

import { isAuDeliveryService, isAuPostcode, isAuStateAbbreviation } from "@mailwoman/codex/au"
import { FSA_LETTER_TO_PROVINCE, normalizeCaPostalCode } from "@mailwoman/codex/ca"
import { isCedex } from "@mailwoman/codex/fr"
import { isNzDeliveryService, isNzPostcode } from "@mailwoman/codex/nz"
import { isPOBox } from "@mailwoman/codex/us"

import { alignRow } from "../align.js"
import {
	maybeNoisifyBoxNumber,
	PO_BOX_LOCALE_TEMPLATES,
	synthesizeMilitaryPoBoxRow,
	type LocaleTemplate,
} from "../synthesize-po-box.js"
import { makeMulberry32, shardSourceID, type CanonicalShardRow, type ShardRecipe } from "./scaffold.js"

// ── Base-skeleton sources ────────────────────────────────────────────────────────────────────────
// Same OA cache as the unit/affix shards. US train = every NON-Vermont state; US eval = Vermont (the
// corpus defaultHoldout). FR comes from the BAN-derived countrywide extract (stride-sampled — the
// file is 2.5 GB and insee-ordered, so a head-only read would be all département 01).
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
const GEONAMES_POSTAL_AU = { zip: "/tmp/geonames-cache/AU-postal.zip", txt: "AU.txt" }
const GEONAMES_POSTAL_NZ = { zip: "/tmp/geonames-cache/NZ-postal.zip", txt: "NZ.txt" }

// ── Surface vocabulary (codex + corpus templates — see the header) ──────────────────────────────
const T: Record<string, LocaleTemplate> = Object.fromEntries(PO_BOX_LOCALE_TEMPLATES.map((t) => [t.locale, t]))
// US: the corpus en-US leaders carry the common mass; the codex-only USPS Pub-28 designators
// (Caller/Drawer/Lockbox — firm-holdout and rural forms) ride at low weight. "Box" is in both.
const US_LEADERS_COMMON = T["en-US"]!.leaders // PO Box, P.O. Box, P.O.Box, PO BOX, POB, Post Office Box, Box
const US_LEADERS_RARE = ["Caller", "Firm Caller", "Drawer", "Lockbox"] // codex US_PO_BOX_DESIGNATORS tail
// "#" EXCLUDED (v4.4.0 probe finding): bare "#N" is a secondary-unit designator per USPS Pub 28 and
// the shipped unit lever labels it `unit` — the corpus template's po_box reading CONTRADICTS a
// shipped convention. PMB stays — a genuine commercial-mail-receiving designator, no unit collision.
const US_PMB_LEADERS = T["en-US"]!.pmb!.filter((l) => l !== "#") // PMB
const FR_LEADERS = T["fr-FR"]!.leaders // BP, B.P., Boîte Postale, BP.
const CA_FR_LEADERS = T["fr-CA"]!.leaders // CP, C.P., Case Postale, BP, B.P.
const CA_EN_LEADERS = T["en-CA"]!.leaders // PO Box, P.O. Box, POB, Post Office Box
// AU (#517): codex/au is the vocabulary truth. Current designators (live auspost.com.au pages) at
// full weight; the AMAS-legacy rural/community tail rides at the same 10% rare-dial as the US
// Caller/Drawer tail. Every emitted phrase must round-trip the codex matcher (makeAuNzPoBoxPhrase).
const AU_LEADERS_CURRENT = ["PO Box", "P.O. Box", "Post Office Box", "GPO Box", "Locked Bag", "Private Bag"]
const AU_LEADERS_LEGACY = ["RMB", "RSD", "CMB"] // codex legacy: true (recognize-only forms)
// NZ (#517): the ADV358 box/bag types that carry an identifier. CMB rides rare (its "CMB B99"
// identifier shape is alpha-led, covered by makeAuNzPoBoxPhrase). Counter Delivery / Poste Restante
// are identifier-less counter services — no number to learn, excluded from synthesis.
const NZ_LEADERS_COMMON = ["PO Box", "Private Bag"]
const NZ_LEADERS_RARE = ["CMB"]

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
const CLASS_MIX: ReadonlyArray<[string, number]> = [
	["po-box-us", 0.27],
	["po-box-us-military", 0.05], // #517: CMR/PSC/Unit + Box, APO/FPO/DPO + AA/AE/AP — the arena's 0/3 class
	["pmb-us", 0.07],
	["bp-fr", 0.1],
	["cedex-fr", 0.17],
	["cp-ca-fr", 0.12],
	["po-box-ca-en", 0.04],
	["po-box-au", 0.12],
	["po-box-nz", 0.06],
]

/** Synthetic recipient/venue prefixes — the arena's "JOHN DOE, ACME INC, …" pattern. */
const VENUES_EN = ["John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Maria Garcia", "Riverside Clinic"]
const VENUES_FR = ["Société Dupont", "Cabinet Martin", "Hôpital Central", "Mairie Annexe", "Imprimerie Moderne"]

// ── Tuple shapes ─────────────────────────────────────────────────────────────────────────────────
interface UsTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
}
interface FrTuple {
	house_number: string
	street: string
	locality: string
	postcode: string
}
interface AuTuple {
	locality: string
	region: string
	postcode: string
}
interface NzTuple {
	locality: string
	postcode: string
}
interface Rendered {
	fmt: string
	raw: string
	components: Record<string, string>
}

// ── Holdout + CSV helpers ────────────────────────────────────────────────────────────────────────

/** Stable locality hash for the FR/CA train↔golden split (djb2; hash%10===0 → golden-only). */
function localityHash(name: string): number {
	let h = 5381
	const s = name.toLowerCase()

	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
	}

	return h
}
const isHoldoutLocality = (name: string): boolean => localityHash(name) % 10 === 0

/** Minimal RFC-4180-ish splitter (handles quoted fields). */
function splitCSV(line: string): string[] {
	const out: string[] = []
	let cur = ""
	let inQ = false

	for (let i = 0; i < line.length; i++) {
		const c = line[i]!

		if (inQ) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"'
					i++
				} else {
					inQ = false
				}
			} else {
				cur += c
			}
		} else if (c === '"') {
			inQ = true
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

const cleanLocality = (loc: string) => loc && loc.length <= 40 && !/\d|,/.test(loc) && !/cedex/i.test(loc)

/** Stream real US tuples (number/street/city/postcode) out of a cached OA zip. */
function readUsTuples(source: { zip: string; csv: string; region: string }): UsTuple[] {
	const r = spawnSync("unzip", ["-p", source.zip, source.csv], { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" })

	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)

		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)

	if (lines.length < 2) return []
	const header = splitCSV(lines[0]!).map((h) => h.trim().toLowerCase())
	const idx = (name: string) => header.indexOf(name)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iPost = idx("postcode")
	const get = (cells: string[], i: number) => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples: UsTuple[] = []
	const seen = new Set<string>()

	for (let li = 1; li < lines.length; li++) {
		if (!lines[li]) continue
		const cells = splitCSV(lines[li]!)
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
 * Stride-sampled FR tuples (number/street/city/postcode). The countrywide CSV is 2.5 GB and insee-ordered; `awk NR%K`
 * strides the whole country instead of reading one département. Quoted commas survive because awk only FILTERS lines —
 * parsing stays in splitCSV.
 */
function readFrTuples(limit: number): FrTuple[] {
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
	const header = splitCSV(lines[0]!).map((h) => h.trim().toLowerCase())
	const idx = (n: string) => header.indexOf(n)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iPost = idx("postcode")
	const get = (cells: string[], i: number) => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples: FrTuple[] = []
	const seen = new Set<string>()

	for (let li = 1; li < lines.length; li++) {
		if (!lines[li]) continue
		const cells = splitCSV(lines[li]!)
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
 * Canadian locality pools from the GeoNames dump (CC-BY 4.0): feature class P, admin1 10 (Québec) / 08 (Ontario),
 * population > 1000. GeoNames is the provenance-tracked source — no hand list.
 */
function readCaLocalities(admin1: string): string[] {
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

/**
 * Real (locality, state?, postcode) tuples from a GeoNames postal-code dump (CC-BY 4.0). Tab format: country,
 * postal_code, place_name, admin1_name, admin1_code, … — for AU the admin1_code IS the postal state abbreviation
 * (NSW/VIC/…), validated against the codex table; NZ has no region line so the state column is ignored. Postcodes are
 * validated against the codex 4-digit shape — a dump row that fails the contract is skipped, not emitted as a junk
 * label.
 */
function readPostalTuples(
	source: { zip: string; txt: string },
	opts: { withState: boolean }
): Array<AuTuple | NzTuple> {
	const r = spawnSync("unzip", ["-p", source.zip, source.txt], { maxBuffer: 1024 * 1024 * 64, encoding: "utf8" })

	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)

		return []
	}
	const tuples: Array<AuTuple | NzTuple> = []
	const seen = new Set<string>()
	const validPostcode = opts.withState ? isAuPostcode : isNzPostcode

	for (const line of r.stdout.split("\n")) {
		if (!line) continue
		const cols = line.split("\t")
		const postcode = (cols[1] ?? "").trim()
		const locality = (cols[2] ?? "").trim()
		const region = (cols[4] ?? "").trim()

		if (!cleanLocality(locality) || !validPostcode(postcode)) continue

		if (opts.withState && !isAuStateAbbreviation(region)) continue
		const key = `${locality}|${postcode}`.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)
		tuples.push(opts.withState ? { locality, region, postcode } : { locality, postcode })
	}

	return tuples
}

// ── Rendering helpers ────────────────────────────────────────────────────────────────────────────

/** Box-number distribution (mirrors the corpus defaultPickNumber bands: 70% are 1-3 digits). */
function pickBoxNumber(random: () => number): string {
	const r = random()

	if (r < 0.3) return String(1 + Math.floor(random() * 99))

	if (r < 0.7) return String(100 + Math.floor(random() * 900))

	if (r < 0.95) return String(1000 + Math.floor(random() * 9000))

	return String(10000 + Math.floor(random() * 90000))
}

/** Case dial for the designator phrase: mostly template casing, sometimes UPPER, rarely lower. */
function caseDial(random: () => number, s: string): string {
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
function makePoBoxPhrase(
	random: () => number,
	leaders: ReadonlyArray<string>,
	rareLeaders?: ReadonlyArray<string>
): string {
	let leader = leaders[Math.floor(random() * leaders.length)]!

	if (rareLeaders && random() < 0.1) {
		leader = rareLeaders[Math.floor(random() * rareLeaders.length)]!
	}
	const num = maybeNoisifyBoxNumber(pickBoxNumber(random), random)
	const phrase = leader === "#" ? `#${num}` : `${caseDial(random, leader)} ${num}`

	// Codex round-trip: a phrase built from a codex-known designator and a clean id must satisfy the
	// matcher (the noisy ids — commas/spaces — are corpus-designed adversarial forms the regex rightly
	// rejects, so they're exempt). A failure here is a generation bug; fail loud.
	if (CODEX_COVERED_LEADERS.has(leader.toLowerCase()) && /^[\dA-Za-z][\dA-Za-z-]*$/.test(num) && !isPOBox(phrase)) {
		throw new Error(`generated a po_box phrase the codex matcher rejects: "${phrase}"`)
	}

	return phrase
}

/**
 * A CEDEX designation: "CEDEX 08" / "Cedex 8" / bare "CEDEX". Shape contract = codex fr/cedex — every emitted phrase
 * must satisfy isCedex, loud.
 */
function makeCedex(random: () => number): string {
	const r = random()
	const word = r < 0.6 ? "CEDEX" : r < 0.9 ? "Cedex" : "cedex"
	const phrase = (() => {
		if (random() < 0.2) return word // "33077 BORDEAUX CEDEX" — un-numbered offices are common
		const n = 1 + Math.floor(random() * 20)
		const id = random() < 0.5 ? String(n).padStart(2, "0") : String(n)

		return `${word} ${id}`
	})()

	if (!isCedex(phrase)) throw new Error(`makeCedex emitted a phrase the codex matcher rejects: "${phrase}"`)

	return phrase
}

/**
 * Compose an AU or NZ delivery-service phrase from the codex-sourced leaders. Same contract as makePoBoxPhrase: a
 * phrase built from a codex-known designator and a clean id must round-trip the codex matcher (isAuDeliveryService /
 * isNzDeliveryService) — a failure is a generation bug, loud. Noisy ids (commas / embedded spaces) are corpus-designed
 * adversarial forms, exempt.
 */
function makeAuNzPoBoxPhrase(
	random: () => number,
	leaders: ReadonlyArray<string>,
	rareLeaders: ReadonlyArray<string>,
	validate: (input: unknown) => boolean
): string {
	let leader = leaders[Math.floor(random() * leaders.length)]!

	if (rareLeaders && random() < 0.1) {
		leader = rareLeaders[Math.floor(random() * rareLeaders.length)]!
	}
	let num = maybeNoisifyBoxNumber(pickBoxNumber(random), random)

	// NZ CMB identifiers are alpha-led per the ADV358 example ("CMB B99").
	if (leader === "CMB" && validate === isNzDeliveryService) {
		num = `B${num}`
	}
	const phrase = `${caseDial(random, leader)} ${num}`
	// The "clean id" shape differs per system: ADV358 identifiers carry no separators at all, the AU
	// AMAS id (like the US one) tolerates dashes. Noisy ids outside the clean shape are exempt.
	const cleanID = validate === isNzDeliveryService ? /^[\dA-Za-z]+$/ : /^[\dA-Za-z][\dA-Za-z-]*$/

	if (cleanID.test(num) && !validate(phrase)) {
		throw new Error(`generated a phrase the codex matcher rejects: "${phrase}"`)
	}

	return phrase
}

/** Synthesize a codex-valid Canadian postcode for a province's FSA letters ("H2X 3V4"). */
function makeCaPostcode(random: () => number, fsaLetters: string[]): string {
	const L = () => CA_INTERIOR_LETTERS[Math.floor(random() * CA_INTERIOR_LETTERS.length)]!
	const D = () => String(Math.floor(random() * 10))
	const first = fsaLetters[Math.floor(random() * fsaLetters.length)]!
	const pc = `${first}${D()}${L()} ${D()}${L()}${D()}`

	// The codex pattern is the contract — a generation bug should fail loud, not emit junk labels.
	if (!normalizeCaPostalCode(pc)) throw new Error(`generated an invalid CA postcode: ${pc}`)

	return pc
}

const pick = <T>(random: () => number, arr: ReadonlyArray<T>): T => arr[Math.floor(random() * arr.length)]!

// ── Per-class renderers — each returns { fmt, raw, components } ──────────────────────────────────

function renderPoBoxUs(random: () => number, t: UsTuple): Rendered {
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
	const up = (s: string) => s.toUpperCase()

	return {
		fmt: "label-nocomma",
		raw: pc ? `${up(phrase)} ${up(loc)} ${reg} ${pc}` : `${up(phrase)} ${up(loc)} ${reg}`,
		components: { po_box: up(phrase), locality: up(loc), region: reg, ...(pc ? { postcode: pc } : {}) },
	}
}

function renderPmbUs(random: () => number, t: UsTuple): Rendered {
	const phrase = makePoBoxPhrase(random, US_PMB_LEADERS)
	const { house_number: hn, street, locality: loc, region: reg, postcode: pc } = t
	const road = `${hn} ${street}`
	const components = { house_number: hn, street, po_box: phrase, locality: loc, region: reg, postcode: pc }
	const r = random()

	if (r < 0.5) return { fmt: "pmb-after-street", raw: `${road} ${phrase}, ${loc}, ${reg} ${pc}`, components }

	if (r < 0.85) return { fmt: "pmb-comma", raw: `${road}, ${phrase}, ${loc}, ${reg} ${pc}`, components }

	return { fmt: "pmb-bare", raw: `${road} ${phrase}`, components: { house_number: hn, street, po_box: phrase } }
}

function renderBpFr(random: () => number, t: FrTuple): Rendered {
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

function renderCedexFr(random: () => number, t: FrTuple): Rendered {
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

function renderCaFr(random: () => number, loc: string): Rendered {
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

function renderCaEn(random: () => number, loc: string): Rendered {
	const phrase = makePoBoxPhrase(random, CA_EN_LEADERS)
	const pc = makeCaPostcode(random, ON_FSA_LETTERS)
	const components = { po_box: phrase, locality: loc, region: "ON", postcode: pc }
	const r = random()

	if (r < 0.5) return { fmt: "ca-en-standard", raw: `${phrase}, ${loc}, ON ${pc}`, components }

	if (r < 0.8) return { fmt: "ca-en-golden-order", raw: `${phrase}, ${pc} ${loc}, ON`, components }

	return { fmt: "ca-en-bare", raw: phrase, components: { po_box: phrase } }
}

function renderAuPoBox(random: () => number, t: AuTuple): Rendered {
	const phrase = makeAuNzPoBoxPhrase(random, AU_LEADERS_CURRENT, AU_LEADERS_LEGACY, isAuDeliveryService)
	const { locality, region: reg, postcode: pc } = t
	const r = random()
	// The guideline last line is capitals ("SYDNEY NSW 2000"); mixed case rides as a softer variant.
	const loc = r < 0.6 ? locality.toUpperCase() : locality
	const base = { po_box: phrase, locality: loc, region: reg, postcode: pc }

	if (r < 0.45) return { fmt: "au-standard", raw: `${phrase}, ${loc} ${reg} ${pc}`, components: base }

	if (r < 0.6) {
		// The envelope label form: comma-less, designator upper-cased ("GPO BOX 123 SYDNEY NSW 2001").
		const up = phrase.toUpperCase()

		return {
			fmt: "au-label-nocomma",
			raw: `${up} ${locality.toUpperCase()} ${reg} ${pc}`,
			components: { po_box: up, locality: locality.toUpperCase(), region: reg, postcode: pc },
		}
	}

	if (r < 0.75)
		return {
			fmt: "au-no-postcode",
			raw: `${phrase}, ${loc} ${reg}`,
			components: { po_box: phrase, locality: loc, region: reg },
		}

	if (r < 0.88) return { fmt: "au-bare", raw: phrase, components: { po_box: phrase } }
	const v = pick(random, VENUES_EN)

	return { fmt: "au-venue", raw: `${v}, ${phrase}, ${loc} ${reg} ${pc}`, components: { venue: v, ...base } }
}

function renderNzPoBox(random: () => number, t: NzTuple): Rendered {
	const phrase = makeAuNzPoBoxPhrase(random, NZ_LEADERS_COMMON, NZ_LEADERS_RARE, isNzDeliveryService)
	const { locality, postcode: pc } = t
	// NZ addresses are written mixed-case ("PO Box 4099, Timaru 7942") — no region line (ADV358).
	const base = { po_box: phrase, locality, postcode: pc }
	const r = random()

	if (r < 0.55) return { fmt: "nz-standard", raw: `${phrase}, ${locality} ${pc}`, components: base }

	if (r < 0.7) return { fmt: "nz-no-postcode", raw: `${phrase}, ${locality}`, components: { po_box: phrase, locality } }

	if (r < 0.85) return { fmt: "nz-bare", raw: phrase, components: { po_box: phrase } }
	const v = pick(random, VENUES_EN)

	return { fmt: "nz-venue", raw: `${v}, ${phrase}, ${locality} ${pc}`, components: { venue: v, ...base } }
}

// ── Component ordering ───────────────────────────────────────────────────────────────────────────

/**
 * Order components so short, collision-prone needles (2-letter regions) are located AFTER the long anchored ones —
 * alignRow claims spans greedily in insertion order, and a leading "on" inside "London" must already be claimed by
 * `locality` before `region: "ON"` goes looking.
 */
const COMPONENT_ORDER = ["house_number", "street", "po_box", "venue", "locality", "postcode", "region", "cedex"]
function orderComponents(components: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}

	for (const k of COMPONENT_ORDER) {
		const v = components[k]

		if (v) {
			out[k] = v
		}
	}

	return out
}

export const poBoxCedexRecipe: ShardRecipe = {
	name: "po-box-cedex",
	description: "PO box / CEDEX coverage rows (US/FR/CA/AU/NZ) — self-generated from cached OA + GeoNames pools",
	mode: "generate",
	options: [{ flag: "--golden", description: "Emit the leakage-safe holdout variant ({raw, components, country})" }],
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 50000
		const source = opts.sourceName ?? "synth-po-box-cedex"

		// US pool: VT only for golden, non-VT for train (the established geographic holdout).
		const usPool: UsTuple[] = []

		for (const s of opts.golden ? [US_EVAL_SOURCE] : US_TRAIN_SOURCES) {
			const t = readUsTuples(s)
			console.error(`  ${s.csv}: ${t.length} tuples`)

			for (const x of t) {
				usPool.push(x)
			}
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
		// AU/NZ pools: same stable locality-hash holdout as FR/CA.
		const auAll = readPostalTuples(GEONAMES_POSTAL_AU, { withState: true }) as AuTuple[]
		const nzAll = readPostalTuples(GEONAMES_POSTAL_NZ, { withState: false }) as NzTuple[]
		const auPool = auAll.filter((t) => isHoldoutLocality(t.locality) === opts.golden)
		const nzPool = nzAll.filter((t) => isHoldoutLocality(t.locality) === opts.golden)
		console.error(`  GeoNames postal: AU ${auAll.length}→${auPool.length}, NZ ${nzAll.length}→${nzPool.length}`)

		if (
			usPool.length === 0 ||
			frPool.length === 0 ||
			qcPool.length === 0 ||
			onPool.length === 0 ||
			auPool.length === 0 ||
			nzPool.length === 0
		) {
			throw new Error(
				"A base pool is empty — check /tmp/oa-cache and /tmp/geonames-cache (CA.zip, AU-postal.zip, NZ-postal.zip)."
			)
		}

		const pickClass = (r: number): string => {
			let acc = 0

			for (const [name, w] of CLASS_MIX) {
				acc += w

				if (r < acc) return name
			}

			return CLASS_MIX[CLASS_MIX.length - 1]![0]
		}

		let emitted = 0
		let skipped = 0
		let guard = 0

		while (emitted < count && guard++ < count * 10) {
			const cls = pickClass(random())
			let rendered: Rendered
			let country: string
			let locale: string

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
			} else if (cls === "po-box-au") {
				rendered = renderAuPoBox(random, pick(random, auPool))
				country = "AU"
				locale = "en-AU"
			} else if (cls === "po-box-nz") {
				rendered = renderNzPoBox(random, pick(random, nzPool))
				country = "NZ"
				locale = "en-NZ"
			} else if (cls === "po-box-us-military") {
				// #517: self-contained (no real-tuple tail) — APO/FPO/DPO locality + AA/AE/AP region + theatre
				// ZIP, codex-backed. Strip the synthesizer's `country` field (the build sets country below).
				const m = synthesizeMilitaryPoBoxRow({ random })
				const { country: _c, ...comps } = m.components
				rendered = { fmt: "po-box-military", raw: m.raw, components: comps as Record<string, string> }
				country = "US"
				locale = "en-US"
			} else {
				rendered = renderCaEn(random, pick(random, onPool))
				country = "CA"
				locale = "en-CA"
			}
			const { raw, components } = rendered

			// Every component surface must survive verbatim in raw, else alignment can't label it.
			if (!Object.values(components).every((s) => raw.includes(s))) {
				skipped++
				continue
			}

			if (opts.golden) {
				write(JSON.stringify({ raw, components: orderComponents(components), country }) + "\n")
				emitted++
				continue
			}
			const canonical: CanonicalShardRow = {
				raw,
				components: orderComponents(components),
				country,
				locale,
				source,
				source_id: shardSourceID(source, components),
				corpus_version: "0.4.0",
				license:
					country === "CA"
						? "GeoNames CA (CC-BY 4.0) locality skeletons + Canada Post box forms (corpus templates); postcodes synthesized to the codex CA pattern"
						: country === "FR"
							? "OpenAddresses FR (BAN-derived) skeletons + La Poste BP/CEDEX forms (corpus templates, NF Z 10-011)"
							: country === "AU"
								? "GeoNames AU postal dump (CC-BY 4.0) locality/state/postcode tails + Australia Post Postal Delivery Type designators (@mailwoman/codex/au)"
								: country === "NZ"
									? "GeoNames NZ postal dump (CC-BY 4.0) locality/postcode tails + NZ Post ADV358 Delivery Service Types (@mailwoman/codex/nz)"
									: "OpenAddresses US (non-VT) skeletons + USPS Pub-28 §29 PO-box designators (codex/corpus templates)",
			}
			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++
				continue
			}
			write(JSON.stringify({ ...aligned.row, synth_method: cls, synth_base_id: null }) + "\n")
			emitted++
		}

		return { emitted, skipped }
	},
}
