/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `po-box-cedex` slice recipe — the po_box / cedex coverage change of the parity campaign (the
 *   unit-slice playbook applied to the two starved tags `po_box` and `cedex`). Generate-mode,
 *   self-contained. Ported from scripts/build-po-box-cedex-slice.mjs.
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
 *   OA zips in `$MAILWOMAN_DATA_ROOT/oa-cache`, the GeoNames Canada dump at
 *   `$MAILWOMAN_DATA_ROOT/geonames/CA.zip`, and the GeoNames POSTAL-CODE dumps for AU/NZ
 *   (`$MAILWOMAN_DATA_ROOT/geonames-postal/{AU,NZ}.zip`).
 *
 *   Byte-fidelity: the legacy script seeded its own mulberry32 from `--seed`
 *   (`mulberry32(opts.seed)`); this recipe re-creates the SAME generator
 *   (`makeMulberry32(opts.seed)`) and preserves the synthesis call order exactly, so `--seed N`
 *   reproduces the legacy run byte-for-byte.
 */

import { isAuDeliveryService, isAuPostcode, isAuStateAbbreviation } from "@mailwoman/codex/au"
import { FSA_LETTER_TO_PROVINCE, normalizeCaPostalCode } from "@mailwoman/codex/ca"
import { isCedex } from "@mailwoman/codex/fr"
import { isNZDeliveryService, isNZPostcode } from "@mailwoman/codex/nz"
import { isPOBox } from "@mailwoman/codex/us"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator, TSVSpliterator } from "spliterator"

import {
	readCSVRecords,
	readZippedCSVRecords,
	sliceSourceID,
	type CanonicalSliceRow,
	type CorpusRecipe,
} from "#recipes/scaffold"
import {
	maybeNoisifyBoxNumber,
	PO_BOX_LOCALE_TEMPLATES,
	synthesizeMilitaryPoBoxRow,
	type LocaleTemplate,
} from "#synthesizers/po-box"
import { pick, tieredNumber } from "#synthesizers/utils"
import { alignRow } from "#utils"

// ── Base-skeleton sources ────────────────────────────────────────────────────────────────────────
// Same OA cache as the unit/affix slices. US train = every NON-Vermont state; US eval = Vermont (the
// corpus defaultHoldout). FR comes from the BAN-derived countrywide extract (stride-sampled — the
// file is 2.5 GB and insee-ordered, so a head-only read would be all département 01).

const US_TRAIN_SOURCES = [
	{ zip: dataRootPath("oa-cache", "us__ca__berkeley.zip"), csv: "us/ca/berkeley.csv", region: "CA" },
	{ zip: dataRootPath("oa-cache", "us__ca__marin.zip"), csv: "us/ca/marin.csv", region: "CA" },
	{ zip: dataRootPath("oa-cache", "us__dc__statewide.zip"), csv: "us/dc/statewide.csv", region: "DC" },
	{ zip: dataRootPath("oa-cache", "us__ia__statewide.zip"), csv: "us/ia/statewide.csv", region: "IA" },
	{ zip: dataRootPath("oa-cache", "us__il__cook.zip"), csv: "us/il/cook.csv", region: "IL" },
	{ zip: dataRootPath("oa-cache", "us__mt__statewide.zip"), csv: "us/mt/statewide.csv", region: "MT" },
	{ zip: dataRootPath("oa-cache", "us__sd__statewide.zip"), csv: "us/sd/statewide.csv", region: "SD" },
]

const US_EVAL_SOURCE = {
	zip: dataRootPath("oa-cache", "us__vt__statewide.zip"),
	csv: "us/vt/statewide.csv",
	region: "VT",
}

const FR_SOURCE = { zip: dataRootPath("oa-cache", "fr__countrywide.zip"), csv: "fr/countrywide.csv" }
// GeoNames has two per-country exports with different schemas, and this recipe reads both. The MAIN
// dump (feature class + population columns) lives under `geonames/`; the POSTAL-CODE dump lives
// under `geonames-postal/`, where the directory carries the "postal" distinction the filename used
// to.
const GEONAMES_CA = dataRootPath("geonames", "CA.zip")
const GEONAMES_POSTAL_AU = { zip: dataRootPath("geonames-postal", "AU.zip"), txt: "AU.txt" }
const GEONAMES_POSTAL_NZ = { zip: dataRootPath("geonames-postal", "NZ.zip"), txt: "NZ.txt" }

/**
 * ── Surface vocabulary (codex + corpus templates — see the header) ──────────────────────────────.
 */
const T: Record<string, LocaleTemplate> = Object.fromEntries(PO_BOX_LOCALE_TEMPLATES.map((t) => [t.locale, t]))
// US: the corpus en-US leaders carry the common mass; the codex-only USPS Pub-28 designators
// (Caller/Drawer/Lockbox — firm-holdout and rural forms) ride at low weight. "Box" is in both.
/**
 * PO Box, P.O. Box, P.O.Box, PO BOX, POB, Post Office Box, Box.
 */
const US_LEADERS_COMMON = T["en-US"]!.leaders
/**
 * Codex US_PO_BOX_DESIGNATORS tail.
 */
const US_LEADERS_RARE = ["Caller", "Firm Caller", "Drawer", "Lockbox"]
// "#" EXCLUDED (v4.4.0 probe finding): bare "#N" is a secondary-unit designator per USPS Pub 28 and
// the shipped unit change labels it `unit` — the corpus template's po_box reading CONTRADICTS a
// shipped convention. PMB stays — a genuine commercial-mail-receiving designator, no unit collision.
/**
 * PMB.
 */
const US_PMB_LEADERS = T["en-US"]!.pmb!.filter((l) => l !== "#")
/**
 * BP, B.P., Boîte Postale, BP.
 */
const FR_LEADERS = T["fr-FR"]!.leaders
/**
 * CP, C.P., Case Postale, BP, B.P.
 */
const CA_FR_LEADERS = T["fr-CA"]!.leaders
/**
 * PO Box, P.O. Box, POB, Post Office Box.
 */
const CA_EN_LEADERS = T["en-CA"]!.leaders
/**
 * AU (#517): codex/au is the vocabulary truth. Current designators (live auspost.com.au pages) at full weight; the
 * AMAS-legacy rural/community tail rides at the same 10% rare-dial as the US Caller/Drawer tail. Every emitted phrase
 * must round-trip the codex matcher (makeAuNzPoBoxPhrase).
 */
const AU_LEADERS_CURRENT = ["PO Box", "P.O. Box", "Post Office Box", "GPO Box", "Locked Bag", "Private Bag"]
/**
 * Codex legacy: true (recognize-only forms)
 */
const AU_LEADERS_LEGACY = ["RMB", "RSD", "CMB"]
/**
 * NZ (#517): the ADV358 box/bag types that carry an identifier. CMB rides rare (its "CMB B99" identifier shape is
 * alpha-led, covered by makeAuNzPoBoxPhrase). Counter Delivery / Poste Restante are identifier-less counter services —
 * no number to learn, excluded from synthesis.
 */
const NZ_LEADERS_COMMON = ["PO Box", "Private Bag"]
const NZ_LEADERS_RARE = ["CMB"]

/**
 * Canadian postcode synthesis: valid first letters per province from the codex FSA prior, interior letters per the
 * codex pattern (excludes the visually ambiguous D F I O Q U). The LDU digits are random — the SHAPE is the training
 * signal, not the (unknowable) live assignment.
 */
const QC_FSA_LETTERS = Object.entries(FSA_LETTER_TO_PROVINCE)
	.filter(([, p]) => p === "QC")
	.map(([l]) => l)

// G H J
const ON_FSA_LETTERS = Object.entries(FSA_LETTER_TO_PROVINCE)
	.filter(([, p]) => p === "ON")
	.map(([l]) => l)

// K L M N P
const CA_INTERIOR_LETTERS = "ABCEGHJKLMNPRSTVWXYZ"

/**
 * Class mix — po_box mass leans US (the production arena), cedex gets a real block, and the CA-fr class exists because
 * the #511 Montréal rows ("Case Postale 200, H3A 1B9 Montréal, QC") fail today.
 */
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

/**
 * Synthetic recipient/venue prefixes — the arena's "JOHN DOE, ACME INC, …" pattern.
 */
const VENUES_EN = ["John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Maria Garcia", "Riverside Clinic"]
const VENUES_FR = ["Société Dupont", "Cabinet Martin", "Hôpital Central", "Mairie Annexe", "Imprimerie Moderne"]

// ── Tuple shapes ─────────────────────────────────────────────────────────────────────────────────
interface USTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
}

interface FRTuple {
	house_number: string
	street: string
	locality: string
	postcode: string
}

interface AUTuple {
	locality: string
	region: string
	postcode: string
}

interface NZTuple {
	locality: string
	postcode: string
}

interface Rendered {
	fmt: string
	raw: string
	components: Record<string, string>
}

// ── Holdout + CSV helpers ────────────────────────────────────────────────────────────────────────

/**
 * Stable locality hash for the FR/CA train↔golden split (djb2; hash%10===0 → golden-only).
 */
function localityHash(name: string): number {
	let h = 5381
	const s = name.toLowerCase()

	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
	}

	return h
}

const isHoldoutLocality = (name: string): boolean => localityHash(name) % 10 === 0

const MAX_LOCALITY_LENGTH = 40

const cleanLocality = (loc: string) =>
	loc && loc.length <= MAX_LOCALITY_LENGTH && !/\d|,/.test(loc) && !/cedex/i.test(loc)

/**
 * Stream real US tuples (number/street/city/postcode) out of a cached OA zip.
 */
async function readUsTuples(source: { zip: PathBuilderLike; csv: string; region: string }): Promise<USTuple[]> {
	const tuples: USTuple[] = []
	const seen = new Set<string>()

	for await (const row of readZippedCSVRecords(source.zip, source.csv)) {
		const locality = row.city ?? ""

		if (!cleanLocality(locality)) continue
		const key = locality.toLowerCase()

		const street = row.street ?? "",
			house_number = row.number ?? ""

		// One tuple per (locality, street) pair keeps the pool varied without ballooning memory.
		const pairKey = `${key}|${street}`.toLowerCase()

		if (seen.has(pairKey)) continue
		seen.add(pairKey)
		tuples.push({ house_number, street, locality, region: source.region, postcode: row.postcode ?? "" })
	}

	return tuples
}

/**
 * The FR stride: keep line 3, then every 211th. Both numbers are the awk pre-filter's, kept exactly — they select which
 * rows land in the slice, so changing either re-rolls the sample.
 */
const FR_STRIDE = 211
const FR_STRIDE_OFFSET = 3

/**
 * GeoNames population floor for a Canadian locality to enter the pool.
 */
const CA_LOCALITY_MIN_POPULATION = 1000

/**
 * Stride-sampled FR tuples (number/street/city/postcode). The countrywide CSV is 2.5 GB and insee-ordered; `awk NR%K`
 * strides the whole country instead of reading one département.
 *
 * The stride counts PHYSICAL lines, so a record carrying a newline inside a quoted field is two lines to the stride and
 * can be halved by it. That is a sampling artefact of striding before the parse, not of the parse: whichever lines
 * survive are re-assembled into records by the CSV reader, and a halved record fails the field checks below. Hence
 * `skipEmpty: false` and no quote handling on the line split — a blank line still advances the count, exactly as it did
 * when this was `awk NR`, and the rows the stride selects are the rows every existing FR slice was built from.
 */
async function readFrTuples(limit: number): Promise<FRTuple[]> {
	if (!(await pathExists(FR_SOURCE.zip))) {
		console.error(`  WARN: ${FR_SOURCE.zip} is not cached — skipping ${FR_SOURCE.csv}`)

		return []
	}

	const encoder = new TextEncoder()

	const strided = TextSpliterator.fromAsync(readZipEntry(FR_SOURCE.zip, FR_SOURCE.csv), { skipEmpty: false })
		// `index` is 0-based where awk's NR is 1-based, hence the +1: keep the header, then every 211th line at offset 3.
		.filter((_line, index) => index === 0 || (index + 1) % FR_STRIDE === FR_STRIDE_OFFSET)
		.take(limit + 1)
		.map((line) => encoder.encode(line + "\n"))

	const tuples: FRTuple[] = []
	const seen = new Set<string>()

	for await (const row of readCSVRecords(strided)) {
		const locality = row.city ?? "",
			postcode = row.postcode ?? "",
			street = row.street ?? "",
			house_number = row.number ?? ""

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
async function readCaLocalities(admin1: string): Promise<string[]> {
	if (!(await pathExists(GEONAMES_CA))) {
		console.error(`  WARN: ${GEONAMES_CA} is not cached — skipping CA localities (admin1=${admin1})`)

		return []
	}

	const localities = new Set<string>()

	// GeoNames main dump columns, 0-based: 1 name, 6 feature class, 8 country, 10 admin1, 14 population.
	for await (const columns of TSVSpliterator.fromAsync(readZipEntry(GEONAMES_CA, "CA.txt"), { header: false })) {
		if (columns[6] !== "P" || columns[8] !== "CA" || columns[10] !== admin1) continue

		if (Number(columns[14]) <= CA_LOCALITY_MIN_POPULATION) continue

		const name = columns[1] ?? ""

		if (cleanLocality(name)) {
			localities.add(name)
		}
	}

	return [...localities]
}

/**
 * Real (locality, state?, postcode) tuples from a GeoNames postal-code dump (CC-BY 4.0). Tab format: country,
 * postal_code, place_name, admin1_name, admin1_code, … — for AU the admin1_code IS the postal state abbreviation
 * (NSW/VIC/…), validated against the codex table; NZ has no region line so the state column is ignored. Postcodes are
 * validated against the codex 4-digit shape — a dump row that fails the contract is skipped, not emitted as a junk
 * label.
 */
async function readPostalTuples(
	source: { zip: PathBuilderLike; txt: string },
	opts: { withState: boolean }
): Promise<Array<AUTuple | NZTuple>> {
	if (!(await pathExists(source.zip))) {
		console.error(`  WARN: ${source.zip} is not cached — skipping ${source.txt}`)

		return []
	}

	const tuples: Array<AUTuple | NZTuple> = []
	const seen = new Set<string>()
	const validPostcode = opts.withState ? isAuPostcode : isNZPostcode

	// A GeoNames dump carries no header row, so every line is data.
	for await (const cols of TSVSpliterator.fromAsync(readZipEntry(source.zip, source.txt), { header: false })) {
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

// Box-number bands: 30% 1–2 digits, 40% 3 digits, 25% 4 digits, 5% 5 digits.
const BOX_TWO_DIGIT_CUTOFF = 0.3
const BOX_THREE_DIGIT_CUTOFF = 0.7
const BOX_FOUR_DIGIT_CUTOFF = 0.95

/**
 * Box-number distribution (mirrors the corpus defaultPickNumber bands: 70% are 1-3 digits).
 */
function pickBoxNumber(random: () => number): string {
	return tieredNumber(random, [
		{ cutoff: BOX_TWO_DIGIT_CUTOFF, base: 1, span: 99 },
		{ cutoff: BOX_THREE_DIGIT_CUTOFF, base: 100, span: 900 },
		{ cutoff: BOX_FOUR_DIGIT_CUTOFF, base: 1000, span: 9000 },
		{ base: 10_000, span: 90_000 },
	])
}

// Designator casing: 70% as templated, 22% UPPER, 8% lower.
const TEMPLATE_CASE_CUTOFF = 0.7
const UPPER_CASE_CUTOFF = 0.92

/**
 * Case dial for the designator phrase: mostly template casing, sometimes UPPER, rarely lower.
 */
function caseDial(random: () => number, s: string): string {
	const r = random()

	if (r < TEMPLATE_CASE_CUTOFF) return s

	if (r < UPPER_CASE_CUTOFF) return s.toUpperCase()

	return s.toLowerCase()
}

/**
 * Leaders the codex PO_BOX_RE genuinely covers (everything en-US except "POB"; PMB/"#" are the corpus's CMRA forms,
 * outside USPS Pub-28 §29). Used to scope the isPOBox round-trip assertion.
 */
const CODEX_COVERED_LEADERS = new Set(
	["PO Box", "P.O. Box", "P.O.Box", "PO BOX", "Post Office Box", "Box", ...US_LEADERS_RARE].map((l) => l.toLowerCase())
)

// One leader in ten comes from the rare list when the caller supplies one (shared with the AU/NZ composer).
const RARE_LEADER_SHARE = 0.1

/**
 * Compose a po_box phrase. "#" joins without a space ("#500", the golden PMB variant).
 */
function makePoBoxPhrase(
	random: () => number,
	leaders: ReadonlyArray<string>,
	rareLeaders?: ReadonlyArray<string>
): string {
	let leader = pick(leaders, random)

	if (rareLeaders && random() < RARE_LEADER_SHARE) {
		leader = pick(rareLeaders, random)
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

// CEDEX word casing: 60% CEDEX, 30% Cedex, 10% cedex; one office in five is un-numbered.
const CEDEX_UPPER_CUTOFF = 0.6
const CEDEX_TITLE_CUTOFF = 0.9
const CEDEX_UNNUMBERED_SHARE = 0.2

/**
 * A CEDEX designation: "CEDEX 08" / "Cedex 8" / bare "CEDEX". Shape contract = codex fr/cedex — every emitted phrase
 * must satisfy isCedex, loud.
 */
function makeCedex(random: () => number): string {
	const r = random()
	const word = r < CEDEX_UPPER_CUTOFF ? "CEDEX" : r < CEDEX_TITLE_CUTOFF ? "Cedex" : "cedex"

	const phrase = (() => {
		if (random() < CEDEX_UNNUMBERED_SHARE) return word // "33077 BORDEAUX CEDEX" — un-numbered offices are common
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
 * isNZDeliveryService) — a failure is a generation bug, loud. Noisy ids (commas / embedded spaces) are corpus-designed
 * adversarial forms, exempt.
 */
function makeAuNzPoBoxPhrase(
	random: () => number,
	leaders: ReadonlyArray<string>,
	rareLeaders: ReadonlyArray<string>,
	validate: (input: unknown) => boolean
): string {
	let leader = pick(leaders, random)

	if (rareLeaders && random() < RARE_LEADER_SHARE) {
		leader = pick(rareLeaders, random)
	}

	let num = maybeNoisifyBoxNumber(pickBoxNumber(random), random)

	// NZ CMB identifiers are alpha-led per the ADV358 example ("CMB B99").
	if (leader === "CMB" && validate === isNZDeliveryService) {
		num = `B${num}`
	}

	const phrase = `${caseDial(random, leader)} ${num}`
	// The "clean id" shape differs per system: ADV358 identifiers carry no separators at all, the AU
	// AMAS id (like the US one) tolerates dashes. Noisy ids outside the clean shape are exempt.
	const cleanID = validate === isNZDeliveryService ? /^[\dA-Za-z]+$/ : /^[\dA-Za-z][\dA-Za-z-]*$/

	if (cleanID.test(num) && !validate(phrase)) {
		throw new Error(`generated a phrase the codex matcher rejects: "${phrase}"`)
	}

	return phrase
}

/**
 * Synthesize a codex-valid Canadian postcode for a province's FSA letters ("H2X 3V4").
 */
function makeCaPostcode(random: () => number, fsaLetters: string[]): string {
	const L = () => CA_INTERIOR_LETTERS[Math.floor(random() * CA_INTERIOR_LETTERS.length)]!
	const D = () => String(Math.floor(random() * 10))
	const first = pick(fsaLetters, random)
	const pc = `${first}${D()}${L()} ${D()}${L()}${D()}`

	// The codex pattern is the contract — a generation bug should fail loud, not emit junk labels.
	if (!normalizeCaPostalCode(pc)) throw new Error(`generated an invalid CA postcode: ${pc}`)

	return pc
}

// ── Per-class renderers — each returns { fmt, raw, components } ──────────────────────────────────

// US layouts: 40% full (when the tuple has a postcode), 15% no-postcode, 20% bare, 15% venue, 10% label-nocomma.
const US_FULL_CUTOFF = 0.4
const US_NO_POSTCODE_CUTOFF = 0.55
const US_BARE_CUTOFF = 0.75
const US_VENUE_CUTOFF = 0.9

function renderPoBoxUs(random: () => number, t: USTuple): Rendered {
	const phrase = makePoBoxPhrase(random, US_LEADERS_COMMON, US_LEADERS_RARE)
	const { locality: loc, region: reg, postcode: pc } = t
	const base = { po_box: phrase, locality: loc, region: reg }
	const r = random()

	if (r < US_FULL_CUTOFF && pc)
		return { fmt: "full", raw: `${phrase}, ${loc}, ${reg} ${pc}`, components: { ...base, postcode: pc } }

	if (r < US_NO_POSTCODE_CUTOFF) return { fmt: "no-postcode", raw: `${phrase}, ${loc}, ${reg}`, components: base }

	if (r < US_BARE_CUTOFF) return { fmt: "bare", raw: phrase, components: { po_box: phrase } }

	if (r < US_VENUE_CUTOFF) {
		const v = pick(VENUES_EN, random)

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

// PMB layouts: 50% pmb-after-street, 35% pmb-comma, 15% pmb-bare.
const PMB_AFTER_STREET_CUTOFF = 0.5
const PMB_COMMA_CUTOFF = 0.85

function renderPmbUs(random: () => number, t: USTuple): Rendered {
	const phrase = makePoBoxPhrase(random, US_PMB_LEADERS)
	const { house_number: hn, street, locality: loc, region: reg, postcode: pc } = t
	const road = `${hn} ${street}`
	const components = { house_number: hn, street, po_box: phrase, locality: loc, region: reg, postcode: pc }
	const r = random()

	if (r < PMB_AFTER_STREET_CUTOFF)
		return { fmt: "pmb-after-street", raw: `${road} ${phrase}, ${loc}, ${reg} ${pc}`, components }

	if (r < PMB_COMMA_CUTOFF) return { fmt: "pmb-comma", raw: `${road}, ${phrase}, ${loc}, ${reg} ${pc}`, components }

	return { fmt: "pmb-bare", raw: `${road} ${phrase}`, components: { house_number: hn, street, po_box: phrase } }
}

// BP layouts: 45% bp-tail, 15% bp-bare, 20% bp-cedex, 20% bp-venue.
const BP_TAIL_CUTOFF = 0.45
const BP_BARE_CUTOFF = 0.6
const BP_CEDEX_CUTOFF = 0.8

function renderBpFr(random: () => number, t: FRTuple): Rendered {
	const phrase = makePoBoxPhrase(random, FR_LEADERS)
	const { locality, postcode: pc } = t
	const upper = random() < 0.5
	const loc = upper ? locality.toUpperCase() : locality
	const r = random()

	if (r < BP_TAIL_CUTOFF)
		return {
			fmt: "bp-tail",
			raw: `${phrase}, ${pc} ${loc}`,
			components: { po_box: phrase, postcode: pc, locality: loc },
		}

	if (r < BP_BARE_CUTOFF) return { fmt: "bp-bare", raw: phrase, components: { po_box: phrase } }

	if (r < BP_CEDEX_CUTOFF) {
		// The institutional combo line — a BP and a CEDEX routing on the same last line.
		const cedex = makeCedex(random)
		const locUp = locality.toUpperCase()

		return {
			fmt: "bp-cedex",
			raw: `${phrase}, ${pc} ${locUp} ${cedex}`,
			components: { po_box: phrase, postcode: pc, locality: locUp, cedex },
		}
	}

	const v = pick(VENUES_FR, random)

	return {
		fmt: "bp-venue",
		raw: `${v}, ${phrase}, ${pc} ${loc}`,
		components: { venue: v, po_box: phrase, postcode: pc, locality: loc },
	}
}

// 60% upper-case the locality. Layouts: 40% cedex-line, 35% cedex-full, 10% cedex-golden-order, 15% cedex-venue.
const CEDEX_UPPER_LOCALITY_SHARE = 0.6
const CEDEX_LINE_CUTOFF = 0.4
const CEDEX_FULL_CUTOFF = 0.75
const CEDEX_GOLDEN_ORDER_CUTOFF = 0.85

function renderCedexFr(random: () => number, t: FRTuple): Rendered {
	const cedex = makeCedex(random)
	const { house_number: hn, street, locality, postcode: pc } = t
	const loc = random() < CEDEX_UPPER_LOCALITY_SHARE ? locality.toUpperCase() : locality
	const line = { postcode: pc, locality: loc, cedex }
	const r = random()

	if (r < CEDEX_LINE_CUTOFF) return { fmt: "cedex-line", raw: `${pc} ${loc} ${cedex}`, components: line }

	if (r < CEDEX_FULL_CUTOFF)
		return {
			fmt: "cedex-full",
			raw: `${hn} ${street}, ${pc} ${loc} ${cedex}`,
			components: { house_number: hn, street, ...line },
		}

	if (r < CEDEX_GOLDEN_ORDER_CUTOFF)
		return { fmt: "cedex-golden-order", raw: `${pc} ${cedex} ${loc}`, components: line }

	const v = pick(VENUES_FR, random)

	return { fmt: "cedex-venue", raw: `${v}, ${pc} ${loc} ${cedex}`, components: { venue: v, ...line } }
}

// CA-FR layouts: 40% golden-order, 30% native, 15% bare, 15% venue.
const CA_FR_GOLDEN_ORDER_CUTOFF = 0.4
const CA_FR_NATIVE_CUTOFF = 0.7
const CA_FR_BARE_CUTOFF = 0.85

function renderCaFr(random: () => number, loc: string): Rendered {
	const phrase = makePoBoxPhrase(random, CA_FR_LEADERS)
	const pc = makeCaPostcode(random, QC_FSA_LETTERS)
	const components = { po_box: phrase, postcode: pc, locality: loc, region: "QC" }
	const r = random()

	// The #511 golden order: postcode BEFORE locality, region trailing.
	if (r < CA_FR_GOLDEN_ORDER_CUTOFF)
		return { fmt: "ca-fr-golden-order", raw: `${phrase}, ${pc} ${loc}, QC`, components }

	if (r < CA_FR_NATIVE_CUTOFF) return { fmt: "ca-fr-native", raw: `${phrase}, ${loc} QC ${pc}`, components }

	if (r < CA_FR_BARE_CUTOFF) return { fmt: "ca-fr-bare", raw: phrase, components: { po_box: phrase } }
	const v = pick(VENUES_FR, random)

	return { fmt: "ca-fr-venue", raw: `${v}, ${phrase}, ${loc} QC ${pc}`, components: { venue: v, ...components } }
}

// CA-EN layouts: 50% standard, 30% golden-order, 20% bare.
const CA_EN_STANDARD_CUTOFF = 0.5
const CA_EN_GOLDEN_ORDER_CUTOFF = 0.8

function renderCaEn(random: () => number, loc: string): Rendered {
	const phrase = makePoBoxPhrase(random, CA_EN_LEADERS)
	const pc = makeCaPostcode(random, ON_FSA_LETTERS)
	const components = { po_box: phrase, locality: loc, region: "ON", postcode: pc }
	const r = random()

	if (r < CA_EN_STANDARD_CUTOFF) return { fmt: "ca-en-standard", raw: `${phrase}, ${loc}, ON ${pc}`, components }

	if (r < CA_EN_GOLDEN_ORDER_CUTOFF)
		return { fmt: "ca-en-golden-order", raw: `${phrase}, ${pc} ${loc}, ON`, components }

	return { fmt: "ca-en-bare", raw: phrase, components: { po_box: phrase } }
}

// One draw decides casing and layout: the lower 60% upper-case the locality; layouts are 45% au-standard,
// 15% au-label-nocomma, 15% au-no-postcode, 13% au-bare, 12% au-venue.
const AU_UPPER_LOCALITY_CUTOFF = 0.6
const AU_STANDARD_CUTOFF = 0.45
const AU_LABEL_CUTOFF = 0.6
const AU_NO_POSTCODE_CUTOFF = 0.75
const AU_BARE_CUTOFF = 0.88

function renderAUPoBox(random: () => number, t: AUTuple): Rendered {
	const phrase = makeAuNzPoBoxPhrase(random, AU_LEADERS_CURRENT, AU_LEADERS_LEGACY, isAuDeliveryService)
	const { locality, region: reg, postcode: pc } = t
	const r = random()
	// The guideline last line is capitals ("SYDNEY NSW 2000"); mixed case rides as a softer variant.
	const loc = r < AU_UPPER_LOCALITY_CUTOFF ? locality.toUpperCase() : locality
	const base = { po_box: phrase, locality: loc, region: reg, postcode: pc }

	if (r < AU_STANDARD_CUTOFF) return { fmt: "au-standard", raw: `${phrase}, ${loc} ${reg} ${pc}`, components: base }

	if (r < AU_LABEL_CUTOFF) {
		// The envelope label form: comma-less, designator upper-cased ("GPO BOX 123 SYDNEY NSW 2001").
		const up = phrase.toUpperCase()

		return {
			fmt: "au-label-nocomma",
			raw: `${up} ${locality.toUpperCase()} ${reg} ${pc}`,
			components: { po_box: up, locality: locality.toUpperCase(), region: reg, postcode: pc },
		}
	}

	if (r < AU_NO_POSTCODE_CUTOFF)
		return {
			fmt: "au-no-postcode",
			raw: `${phrase}, ${loc} ${reg}`,
			components: { po_box: phrase, locality: loc, region: reg },
		}

	if (r < AU_BARE_CUTOFF) return { fmt: "au-bare", raw: phrase, components: { po_box: phrase } }
	const v = pick(VENUES_EN, random)

	return { fmt: "au-venue", raw: `${v}, ${phrase}, ${loc} ${reg} ${pc}`, components: { venue: v, ...base } }
}

// NZ layouts: 55% nz-standard, 15% nz-no-postcode, 15% nz-bare, 15% nz-venue.
const NZ_STANDARD_CUTOFF = 0.55
const NZ_NO_POSTCODE_CUTOFF = 0.7
const NZ_BARE_CUTOFF = 0.85

function renderNZPoBox(random: () => number, t: NZTuple): Rendered {
	const phrase = makeAuNzPoBoxPhrase(random, NZ_LEADERS_COMMON, NZ_LEADERS_RARE, isNZDeliveryService)
	const { locality, postcode: pc } = t
	// NZ addresses are written mixed-case ("PO Box 4099, Timaru 7942") — no region line (ADV358).
	const base = { po_box: phrase, locality, postcode: pc }
	const r = random()

	if (r < NZ_STANDARD_CUTOFF) return { fmt: "nz-standard", raw: `${phrase}, ${locality} ${pc}`, components: base }

	if (r < NZ_NO_POSTCODE_CUTOFF)
		return { fmt: "nz-no-postcode", raw: `${phrase}, ${locality}`, components: { po_box: phrase, locality } }

	if (r < NZ_BARE_CUTOFF) return { fmt: "nz-bare", raw: phrase, components: { po_box: phrase } }
	const v = pick(VENUES_EN, random)

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

/**
 * Slice recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const poBoxCedexRecipe: CorpusRecipe = {
	name: "po-box-cedex",
	description: "PO box / CEDEX coverage rows (US/FR/CA/AU/NZ) — self-generated from cached OA + GeoNames pools",
	mode: "generate",
	options: [{ flag: "--golden", description: "Emit the leakage-safe holdout variant ({raw, components, country})" }],
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 50_000
		const source = opts.sourceName ?? "synth-po-box-cedex"

		// US pool: VT only for golden, non-VT for train (the established geographic holdout).
		const usPool: USTuple[] = []

		for (const s of opts.golden ? [US_EVAL_SOURCE] : US_TRAIN_SOURCES) {
			const t = await readUsTuples(s)

			console.error(`  ${s.csv}: ${t.length} tuples`)

			for (const x of t) {
				usPool.push(x)
			}
		}

		// FR + CA pools: stable locality-hash holdout (golden gets hash%10==0, train the rest).
		const frAll = await readFrTuples(80_000)
		const frPool = frAll.filter((t) => isHoldoutLocality(t.locality) === opts.golden)

		console.error(`  ${FR_SOURCE.csv}: ${frAll.length} tuples (${frPool.length} after holdout split)`)

		const qcAll = await readCaLocalities("10")
		const onAll = await readCaLocalities("08")
		const qcPool = qcAll.filter((l) => isHoldoutLocality(l) === opts.golden)
		const onPool = onAll.filter((l) => isHoldoutLocality(l) === opts.golden)

		console.error(`  GeoNames CA: QC ${qcAll.length}→${qcPool.length}, ON ${onAll.length}→${onPool.length}`)

		// AU/NZ pools: same stable locality-hash holdout as FR/CA.
		const auAll = (await readPostalTuples(GEONAMES_POSTAL_AU, { withState: true })) as AUTuple[]
		const nzAll = (await readPostalTuples(GEONAMES_POSTAL_NZ, { withState: false })) as NZTuple[]
		const auPool = auAll.filter((t) => isHoldoutLocality(t.locality) === opts.golden)
		const nzPool = nzAll.filter((t) => isHoldoutLocality(t.locality) === opts.golden)

		console.error(`  GeoNames postal: AU ${auAll.length}→${auPool.length}, NZ ${nzAll.length}→${nzPool.length}`)

		if (!usPool.length || !frPool.length || !qcPool.length || !onPool.length || !auPool.length || !nzPool.length) {
			throw new Error(
				`A base pool is empty — check ${dataRootPath("oa-cache")}, ${GEONAMES_CA}, ${GEONAMES_POSTAL_AU.zip}, and ${GEONAMES_POSTAL_NZ.zip}.`
			)
		}

		const pickClass = (r: number): string => {
			let acc = 0

			for (const [name, w] of CLASS_MIX) {
				acc += w

				if (r < acc) return name
			}

			return CLASS_MIX.at(-1)![0]
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
				rendered = renderPoBoxUs(random, pick(usPool, random))
				country = "US"
				locale = "en-US"
			} else if (cls === "pmb-us") {
				const t = pick(usPool, random)

				if (!t.postcode || !t.street || !t.house_number) continue
				rendered = renderPmbUs(random, t)
				country = "US"
				locale = "en-US"
			} else if (cls === "bp-fr") {
				rendered = renderBpFr(random, pick(frPool, random))
				country = "FR"
				locale = "fr-FR"
			} else if (cls === "cedex-fr") {
				rendered = renderCedexFr(random, pick(frPool, random))
				country = "FR"
				locale = "fr-FR"
			} else if (cls === "cp-ca-fr") {
				rendered = renderCaFr(random, pick(qcPool, random))
				country = "CA"
				locale = "fr-CA"
			} else if (cls === "po-box-au") {
				rendered = renderAUPoBox(random, pick(auPool, random))
				country = "AU"
				locale = "en-AU"
			} else if (cls === "po-box-nz") {
				rendered = renderNZPoBox(random, pick(nzPool, random))
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
				rendered = renderCaEn(random, pick(onPool, random))
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

			const canonical: CanonicalSliceRow = {
				raw,
				components: orderComponents(components),
				country,
				locale,
				source,
				source_id: sliceSourceID(source, components),
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
