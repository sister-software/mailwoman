/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Synthesis / augmentation per Phase 1 task #6.
 *
 *   An `Augmentation` is a pure function that takes a `CanonicalRow` and either returns a new
 *   `CanonicalRow` (with `raw` AND `components` transformed in lockstep so alignment still
 *   succeeds) or `null` when the augmentation doesn't apply to the row's shape.
 *
 *   Synthesis runs **before** alignment: augmentations transform raw + components together, and the
 *   runner reruns alignment on each augmented row to produce its labels. This keeps the synthesis
 *   surface small (no token/label arithmetic) at the cost of a re-run.
 *
 *   Every augmented row carries the `synth` marker:
 *
 *   - `method`: the augmentation's stable id (e.g. `"case-upper"`, `"accent-strip"`).
 *   - `base_source_id`: the source_id of the un-augmented (or upstream-augmented) row, so ancestry is
 *       traceable.
 *
 *   Phase 1 implements the locale-agnostic + most useful US/FR augmentations. Typo injection (#530)
 *   is now implemented ({@link typoInject}) — the "seed-aware API" the deferral asked for is
 *   resolved by seeding the PRNG from each row's `source_id`. It ships in {@link AUGMENTATIONS} but
 *   is kept OUT of the default set ({@link defaultAugmentationsForCountry}) until its on-model
 *   effect is measured; see the note there.
 */

import {
	US_STREET_SUFFIX_PREFERRED_ABBR,
	US_UNIT_DESIGNATOR_PREFERRED_ABBR,
	matchCase,
	matchLeadingDesignator,
	matchTrailingSuffix,
} from "@mailwoman/codex/us"
import type { BIOLabel, ComponentTag } from "@mailwoman/core/types"

import { alignRow, assertSpanInvariants, type ComponentSpan } from "./align.ts"
import { whitespaceTokenizer, type Tokenizer } from "./tokenize.ts"
import type { CanonicalRow, LabeledRow, QuarantinedRow } from "./types.ts"

/**
 * An augmentation transforms a single row. Return `null` if the augmentation doesn't apply (e.g. accent-strip on a row
 * that has no accents; particle-strip on a US row).
 */
export type Augmentation = (row: CanonicalRow) => CanonicalRow | null

type ComponentDict = Partial<Record<ComponentTag, string>>

/** Helper: build the augmented row with synth marker + chained source_id. */
function withAugmentation(
	source: CanonicalRow,
	method: string,
	newRaw: string,
	newComponents: ComponentDict
): CanonicalRow {
	const baseID = source.synth?.base_source_id ?? source.source_id

	return {
		...source,
		raw: newRaw,
		components: newComponents,
		source_id: `${source.source_id}+${method}`,
		synth: { method, base_source_id: baseID },
	}
}

// ===========================================================================
// Locale-agnostic augmentations
// ===========================================================================

/** Upper-case raw + every component value. Returns null if already all-upper. */
export const caseUpper: Augmentation = (row) => {
	if (row.raw === row.raw.toUpperCase()) return null
	const upRaw = row.raw.toUpperCase()
	const upComponents: ComponentDict = {}

	for (const [k, v] of Object.entries(row.components)) {
		if (v) {
			upComponents[k as ComponentTag] = v.toUpperCase()
		}
	}

	return withAugmentation(row, "case-upper", upRaw, upComponents)
}

/** Lower-case raw + every component value. Returns null if already all-lower. */
export const caseLower: Augmentation = (row) => {
	if (row.raw === row.raw.toLowerCase()) return null
	const downRaw = row.raw.toLowerCase()
	const downComponents: ComponentDict = {}

	for (const [k, v] of Object.entries(row.components)) {
		if (v) {
			downComponents[k as ComponentTag] = v.toLowerCase()
		}
	}

	return withAugmentation(row, "case-lower", downRaw, downComponents)
}

/** Drop commas from `raw`. Components unchanged (they didn't carry commas). */
export const dropCommas: Augmentation = (row) => {
	if (!row.raw.includes(",")) return null
	const newRaw = row.raw.replace(/,/g, "").replace(/\s+/g, " ").trim()

	return withAugmentation(row, "drop-commas", newRaw, { ...row.components })
}

/**
 * Replace single spaces with double spaces in `raw` AND in every component value. The component update is essential for
 * alignment: `alignRow` substring-searches each component's surface form inside `raw`, so doubling the spaces in `raw`
 * only would leave single-spaced components unfindable (this was the bug behind v0.1.1's first build attempt — 99.9% of
 * quarantined rows traced back to this augmentation). Doubling both keeps the substring contract intact.
 */
export const doubleSpace: Augmentation = (row) => {
	if (!/ /.test(row.raw)) return null
	const newRaw = row.raw.replace(/ /g, "  ")
	const newComponents: ComponentDict = {}

	for (const [k, v] of Object.entries(row.components)) {
		if (v) {
			newComponents[k as ComponentTag] = v.replace(/ /g, "  ")
		}
	}

	return withAugmentation(row, "double-space", newRaw, newComponents)
}

/**
 * Strip Unicode combining marks (accents, diacritics) from raw + components. "Hôtel" → "Hotel"; "Île-de-France" →
 * "Ile-de-France". Returns null if the row has no accents.
 */
export const accentStrip: Augmentation = (row) => {
	const stripped = stripAccents(row.raw)

	if (stripped === row.raw) return null
	const newComponents: ComponentDict = {}

	for (const [k, v] of Object.entries(row.components)) {
		if (v) {
			newComponents[k as ComponentTag] = stripAccents(v)
		}
	}

	return withAugmentation(row, "accent-strip", stripped, newComponents)
}

function stripAccents(s: string): string {
	return s.normalize("NFD").replace(/\p{M}/gu, "")
}

// --- typo injection (#530) -------------------------------------------------
// The Phase-1 deferral asked for a "seed-aware API" so the corpus stays reproducible. Resolution:
// seed the PRNG from the row's own `source_id` — deterministic per row, no global state, fits the
// existing `(row) => CanonicalRow | null` signature unchanged.

/** QWERTY adjacency for realistic single-key substitutions (lowercase; case is restored on apply). */
const QWERTY_ADJACENCY: Record<string, string> = {
	a: "qwsz",
	b: "vghn",
	c: "xdfv",
	d: "serfcx",
	e: "wsdr",
	f: "drtgvc",
	g: "ftyhbv",
	h: "gyujnb",
	i: "ujko",
	j: "huikmn",
	k: "jiolm",
	l: "kop",
	m: "njk",
	n: "bhjm",
	o: "iklp",
	p: "ol",
	q: "wa",
	r: "edft",
	s: "awedxz",
	t: "rfgy",
	u: "yhji",
	v: "cfgb",
	w: "qase",
	x: "zsdc",
	y: "tghu",
	z: "asx",
}

/**
 * A component value eligible for a typo: a pure-letter name of ≥4 chars (excludes numbers/postcodes/units).
 */
const ALPHA_NAME = /^[\p{L}][\p{L} '.-]{3,}$/u

/**
 * Djb2 → uint32 seed. Deterministic; no `Math.random` (banned here and breaks corpus reproducibility).
 */
function hashString(s: string): number {
	let h = 5381

	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
	}

	return h >>> 0
}

/** Mulberry32 — a tiny seeded PRNG. Same seed → same stream → reproducible typos. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0

	return () => {
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * Inject ONE realistic typo — an adjacent-QWERTY-key substitution OR an adjacent-character transposition — into a
 * single alpha name component (street/locality/region…), teaching the model to recover from real-world misspellings
 * ("Cupertino" → "Cupertimo"). The edit is applied to BOTH `raw` and the component so the substring contract `alignRow`
 * depends on holds. Number / postcode / unit components are never touched (they fail {@link ALPHA_NAME}). Deterministic
 * per row (seeded from `source_id`). Returns `null` when no eligible component exists or the edit is a no-op.
 */
export const typoInject: Augmentation = (row) => {
	const rng = mulberry32(hashString(`${row.source_id}:typo`))
	// Count occurrences so we only edit an UNAMBIGUOUS target — a value that appears exactly once in
	// raw and isn't a substring of another component. (e.g. "Cupertino" the locality is a substring of
	// "Cupertino Avenue" the street; editing it would `replace` the street's occurrence and break the
	// span. The substring contract `alignRow` enforces is why we filter rather than guess the position.)
	const occurs = (needle: string): number => {
		let n = 0

		for (let i = row.raw.indexOf(needle); i >= 0; i = row.raw.indexOf(needle, i + needle.length)) {
			n++
		}

		return n
	}
	const values = Object.values(row.components).filter(Boolean) as string[]
	const eligible = (Object.entries(row.components) as Array<[ComponentTag, string]>).filter(
		([, v]) => v && ALPHA_NAME.test(v) && occurs(v) === 1 && !values.some((o) => o !== v && o.includes(v))
	)

	if (eligible.length === 0) return null
	const [tag, value] = eligible[Math.floor(rng() * eligible.length)]!
	// Interior alpha positions only — keep the first char (most real typos are interior) + a right neighbour.
	const positions: number[] = []

	for (let i = 1; i < value.length - 1; i++)
		if (/\p{L}/u.test(value[i]!)) {
			positions.push(i)
		}

	if (positions.length === 0) return null
	const i = positions[Math.floor(rng() * positions.length)]!
	const ch = value[i]!
	let typed: string

	if (rng() < 0.5) {
		const next = value[i + 1]!

		if (ch === next) return null // transposing equal chars is a no-op
		typed = value.slice(0, i) + next + ch + value.slice(i + 2)
	} else {
		const lower = ch.toLowerCase()
		const adj = QWERTY_ADJACENCY[lower]

		if (!adj) return null
		const sub = adj[Math.floor(rng() * adj.length)]!
		typed = value.slice(0, i) + (ch !== lower ? sub.toUpperCase() : sub) + value.slice(i + 1)
	}

	if (typed === value) return null
	const newRaw = row.raw.replace(value, typed)

	// first occurrence; `replace(string, …)` is literal, not regex
	return withAugmentation(row, "typo-inject", newRaw, { ...row.components, [tag]: typed })
}

// ===========================================================================
// US-specific augmentations
// ===========================================================================

/** US state full ↔ alpha-2 mapping. Two-way: `STATE_TO_ABBR["Oregon"] = "OR"`. */
const STATE_NAME_TO_ABBR: Record<string, string> = {
	Alabama: "AL",
	Alaska: "AK",
	Arizona: "AZ",
	Arkansas: "AR",
	California: "CA",
	Colorado: "CO",
	Connecticut: "CT",
	Delaware: "DE",
	Florida: "FL",
	Georgia: "GA",
	Hawaii: "HI",
	Idaho: "ID",
	Illinois: "IL",
	Indiana: "IN",
	Iowa: "IA",
	Kansas: "KS",
	Kentucky: "KY",
	Louisiana: "LA",
	Maine: "ME",
	Maryland: "MD",
	Massachusetts: "MA",
	Michigan: "MI",
	Minnesota: "MN",
	Mississippi: "MS",
	Missouri: "MO",
	Montana: "MT",
	Nebraska: "NE",
	Nevada: "NV",
	"New Hampshire": "NH",
	"New Jersey": "NJ",
	"New Mexico": "NM",
	"New York": "NY",
	"North Carolina": "NC",
	"North Dakota": "ND",
	Ohio: "OH",
	Oklahoma: "OK",
	Oregon: "OR",
	Pennsylvania: "PA",
	"Rhode Island": "RI",
	"South Carolina": "SC",
	"South Dakota": "SD",
	Tennessee: "TN",
	Texas: "TX",
	Utah: "UT",
	Vermont: "VT",
	Virginia: "VA",
	Washington: "WA",
	"West Virginia": "WV",
	Wisconsin: "WI",
	Wyoming: "WY",
	"District of Columbia": "DC",
}

const STATE_ABBR_TO_NAME: Record<string, string> = Object.fromEntries(
	Object.entries(STATE_NAME_TO_ABBR).map(([k, v]) => [v, k])
)

/** US: substitute the full state name for its alpha-2 abbreviation. */
export const stateExpand: Augmentation = (row) => {
	if (row.country !== "US") return null
	const region = row.components.region

	if (!region) return null
	const full = STATE_ABBR_TO_NAME[region]

	if (!full) return null
	// Replace the bounded "OR" surface form with "Oregon" in raw. Use word boundaries so we
	// don't match inside "Stop" or similar.
	const re = new RegExp(`\\b${region}\\b`, "g")

	if (!re.test(row.raw)) return null
	const newRaw = row.raw.replace(new RegExp(`\\b${region}\\b`, "g"), full)
	const newComponents: ComponentDict = { ...row.components, region: full }

	return withAugmentation(row, "state-expand", newRaw, newComponents)
}

/** US: substitute the alpha-2 abbreviation for the full state name. */
export const stateAbbreviate: Augmentation = (row) => {
	if (row.country !== "US") return null
	const region = row.components.region

	if (!region) return null
	const abbr = STATE_NAME_TO_ABBR[region]

	if (!abbr) return null
	const re = new RegExp(`\\b${region}\\b`, "g")

	if (!re.test(row.raw)) return null
	const newRaw = row.raw.replace(new RegExp(`\\b${region}\\b`, "g"), abbr)
	const newComponents: ComponentDict = { ...row.components, region: abbr }

	return withAugmentation(row, "state-abbreviate", newRaw, newComponents)
}

const DIRECTIONAL_FULL_TO_ABBR: Record<string, string> = {
	North: "N",
	South: "S",
	East: "E",
	West: "W",
	Northeast: "NE",
	Northwest: "NW",
	Southeast: "SE",
	Southwest: "SW",
}
const DIRECTIONAL_ABBR_TO_FULL: Record<string, string> = Object.fromEntries(
	Object.entries(DIRECTIONAL_FULL_TO_ABBR).map(([k, v]) => [v, k])
)

/** US: expand directional abbreviations in `street`/`street_suffix` (NW → Northwest). */
export const directionalExpand: Augmentation = (row) => {
	if (row.country !== "US") return null
	const tagsToCheck: ComponentTag[] = ["street", "street_suffix", "street_prefix"]
	let changed = false
	let newRaw = row.raw
	const newComponents: ComponentDict = { ...row.components }

	for (const tag of tagsToCheck) {
		const v = newComponents[tag]

		if (!v) continue
		const replaced = v.replace(/\b(N|S|E|W|NE|NW|SE|SW)\b/g, (m) => DIRECTIONAL_ABBR_TO_FULL[m] ?? m)

		if (replaced !== v) {
			newComponents[tag] = replaced
			newRaw = newRaw.replace(new RegExp(`\\b${escapeRegex(v)}\\b`, "g"), replaced)
			changed = true
		}
	}

	if (!changed) return null

	return withAugmentation(row, "directional-expand", newRaw, newComponents)
}

/** US: abbreviate directional words (Northwest → NW). */
export const directionalAbbreviate: Augmentation = (row) => {
	if (row.country !== "US") return null
	const tagsToCheck: ComponentTag[] = ["street", "street_suffix", "street_prefix"]
	let changed = false
	let newRaw = row.raw
	const newComponents: ComponentDict = { ...row.components }

	for (const tag of tagsToCheck) {
		const v = newComponents[tag]

		if (!v) continue
		const replaced = v.replace(
			/\b(North|South|East|West|Northeast|Northwest|Southeast|Southwest)\b/g,
			(m) => DIRECTIONAL_FULL_TO_ABBR[m] ?? m
		)

		if (replaced !== v) {
			newComponents[tag] = replaced
			newRaw = newRaw.replace(new RegExp(`\\b${escapeRegex(v)}\\b`, "g"), replaced)
			changed = true
		}
	}

	if (!changed) return null

	return withAugmentation(row, "directional-abbreviate", newRaw, newComponents)
}

/**
 * US: swap the trailing street-suffix word in `components.street` to its preferred USPS abbreviation, preserving case.
 * `"5th Avenue"` → `"5th Ave"`; `"5TH AVENUE"` → `"5TH AVE"`; `"main street"` → `"main st"`. Returns null when no
 * trailing suffix is recognized, when the trailing word is already the preferred abbreviation, or when the swap would
 * leave `raw` un- touched (alignment requires both raw and components to move in lockstep).
 *
 * Targets the trailing word only to avoid mangling streets like "Avenue of the Americas" where the suffix-shaped word
 * is part of the proper name rather than a USPS suffix.
 */
export const streetSuffixAbbreviate: Augmentation = (row) => {
	if (row.country !== "US") return null
	const street = row.components.street

	if (!street) return null
	const match = matchTrailingSuffix(street)

	if (!match) return null

	const preferred = US_STREET_SUFFIX_PREFERRED_ABBR[match.canonical]
	const target = matchCase(preferred, match.matched)

	if (target === match.matched) return null

	const newStreet = `${street.slice(0, street.lastIndexOf(match.matched))}${target}`

	if (newStreet === street) return null

	const newComponents: ComponentDict = { ...row.components, street: newStreet }
	const newRaw = row.raw.replace(new RegExp(`\\b${escapeRegex(street)}\\b`, "g"), newStreet)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "us-street-suffix-abbreviate", newRaw, newComponents)
}

/**
 * US: swap the trailing street-suffix word in `components.street` to its full canonical form, preserving case. `"5th
 * Ave"` → `"5th Avenue"`; `"5TH AVE"` → `"5TH AVENUE"`; `"main st"` → `"main street"`. Returns null when no trailing
 * suffix is recognized, when the trailing word is already the canonical full form, or when the swap would leave `raw`
 * untouched.
 *
 * Same trailing-word-only rule as `streetSuffixAbbreviate`.
 */
export const streetSuffixExpand: Augmentation = (row) => {
	if (row.country !== "US") return null
	const street = row.components.street

	if (!street) return null
	const match = matchTrailingSuffix(street)

	if (!match) return null

	const target = matchCase(match.canonical, match.matched)

	if (target === match.matched) return null

	const newStreet = `${street.slice(0, street.lastIndexOf(match.matched))}${target}`

	if (newStreet === street) return null

	const newComponents: ComponentDict = { ...row.components, street: newStreet }
	const newRaw = row.raw.replace(new RegExp(`\\b${escapeRegex(street)}\\b`, "g"), newStreet)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "us-street-suffix-expand", newRaw, newComponents)
}

/**
 * US: swap the LEADING secondary-unit designator in `components.unit` to its approved USPS abbreviation, preserving
 * case + the identifier. `"Apartment 4B"` → `"Apt 4B"`; `"SUITE 200"` → `"STE 200"`; `"floor 3"` → `"fl 3"`. Returns
 * null when the unit has no recognized leading designator (a bare `"4B"` / `"#210"`), the designator is already the
 * approved abbreviation, or the swap would leave `raw` untouched.
 *
 * Mirrors `streetSuffixAbbreviate`, but designators LEAD the unit (vs suffixes that trail the street). Sourced from the
 * USPS Pub-28 C2 codex — the data-generation counterpart to the runtime `UnitDesignatorClassifier`.
 */
export const unitDesignatorAbbreviate: Augmentation = (row) => {
	if (row.country !== "US") return null
	const unit = row.components.unit

	if (!unit) return null
	const match = matchLeadingDesignator(unit)

	if (!match) return null

	const preferred = US_UNIT_DESIGNATOR_PREFERRED_ABBR[match.canonical]
	const target = matchCase(preferred, match.matched)

	if (target === match.matched) return null

	const newUnit = `${target}${unit.slice(match.matched.length)}`

	if (newUnit === unit) return null

	const newComponents: ComponentDict = { ...row.components, unit: newUnit }
	const newRaw = row.raw.replace(new RegExp(`\\b${escapeRegex(unit)}\\b`, "g"), newUnit)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "us-unit-designator-abbreviate", newRaw, newComponents)
}

/**
 * US: swap the LEADING secondary-unit designator in `components.unit` to its full canonical form, preserving case + the
 * identifier. `"Apt 4B"` → `"Apartment 4B"`; `"STE 200"` → `"SUITE 200"`. Returns null when there's no recognized
 * leading designator, it's already the canonical word, or the swap would leave `raw` untouched. Same leading-word-only
 * rule as `unitDesignatorAbbreviate`.
 */
export const unitDesignatorExpand: Augmentation = (row) => {
	if (row.country !== "US") return null
	const unit = row.components.unit

	if (!unit) return null
	const match = matchLeadingDesignator(unit)

	if (!match) return null

	const target = matchCase(match.canonical, match.matched)

	if (target === match.matched) return null

	const newUnit = `${target}${unit.slice(match.matched.length)}`

	if (newUnit === unit) return null

	const newComponents: ComponentDict = { ...row.components, unit: newUnit }
	const newRaw = row.raw.replace(new RegExp(`\\b${escapeRegex(unit)}\\b`, "g"), newUnit)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "us-unit-designator-expand", newRaw, newComponents)
}

/** US: ZIP+4 form `12345-6789` → `123456789` (dash dropped). */
export const zipPlus4DashDrop: Augmentation = (row) => {
	if (row.country !== "US") return null
	const postcode = row.components.postcode

	if (!postcode || !/^\d{5}-\d{4}$/.test(postcode)) return null
	const noDash = postcode.replace("-", "")
	const newRaw = row.raw.replace(postcode, noDash)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "zip-plus4-dash-drop", newRaw, { ...row.components, postcode: noDash })
}

// ===========================================================================
// FR-specific augmentations
// ===========================================================================

/** FR: drop the article particle from a street ("Rue de la République" → "Rue République"). */
export const particleStrip: Augmentation = (row) => {
	if (row.country !== "FR") return null
	const particle = row.components.street_prefix_particle

	if (!particle) return null
	const newComponents: ComponentDict = { ...row.components }
	delete newComponents.street_prefix_particle
	// Drop the particle from raw, then collapse any double spaces.
	const re = new RegExp(`\\s+${escapeRegex(particle)}\\s+`, "g")

	if (!re.test(row.raw)) return null
	const newRaw = row.raw.replace(re, " ").replace(/\s+/g, " ").trim()

	return withAugmentation(row, "particle-strip", newRaw, newComponents)
}

// ===========================================================================
// Registry + default policies
// ===========================================================================

/** Stable id → augmentation table. */
export const AUGMENTATIONS: Record<string, Augmentation> = {
	"case-upper": caseUpper,
	"case-lower": caseLower,
	"drop-commas": dropCommas,
	"double-space": doubleSpace,
	"accent-strip": accentStrip,
	"state-expand": stateExpand,
	"state-abbreviate": stateAbbreviate,
	"directional-expand": directionalExpand,
	"directional-abbreviate": directionalAbbreviate,
	"us-street-suffix-abbreviate": streetSuffixAbbreviate,
	"us-street-suffix-expand": streetSuffixExpand,
	"us-unit-designator-abbreviate": unitDesignatorAbbreviate,
	"us-unit-designator-expand": unitDesignatorExpand,
	"zip-plus4-dash-drop": zipPlus4DashDrop,
	"particle-strip": particleStrip,
	"typo-inject": typoInject,
}

/** Default augmentation set, by country. Phase 1: US + FR; others get the locale-agnostic set. */
export function defaultAugmentationsForCountry(country: string): readonly Augmentation[] {
	// `typoInject` (#530) is deliberately NOT in the default set. It is implemented, tested, and
	// registered in {@link AUGMENTATIONS} so callers can opt in (add it here or compose it directly),
	// but it changes the synthesized corpus distribution and its effect on the trained model is not
	// yet measured. Per the project's default-OFF discipline, promotion into the default build is an
	// operator call once an A/B vs the current corpus exists — keeping the default byte-stable.
	const universal = [caseUpper, caseLower, dropCommas, doubleSpace]

	switch (country) {
		case "US":
			return [
				...universal,
				stateExpand,
				stateAbbreviate,
				directionalExpand,
				directionalAbbreviate,
				streetSuffixAbbreviate,
				streetSuffixExpand,
				unitDesignatorAbbreviate,
				unitDesignatorExpand,
				zipPlus4DashDrop,
			]
		case "FR":
			return [...universal, accentStrip, particleStrip]
		default:
			return universal
	}
}

/**
 * Run every augmentation against a row; collect the non-null outputs. The augmentations are pure, so callers can
 * compose them off this generator (e.g. nesting accent-strip ∘ state-abbreviate).
 */
export function* synthesizeRow(
	row: CanonicalRow,
	augmentations: readonly Augmentation[] = defaultAugmentationsForCountry(row.country)
): Generator<CanonicalRow> {
	for (const aug of augmentations) {
		const out = aug(row)

		if (out) {
			yield out
		}
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ===========================================================================
// Compositional synthesis (Phase 1.6 §2.1)
// ===========================================================================
//
// The single-row augmentations above transform one `CanonicalRow` into another with `raw` and
// `components` moved in lockstep, leaving alignment to derive labels downstream. Composition is
// fundamentally different: it takes a **venue string** and an **address row** from a different
// source and renders them together as a single `raw`, producing adversarial training examples
// where embedded place-shaped tokens collide with real address components.
//
// Naive post-hoc alignment of the composed string would mis-label the embedded tokens: a venue
// like `"Buffalo Health Clinic"` shares the token `"Buffalo"` with an address locality
// `"Buffalo, NY"`, and alignment's leftmost-substring search would claim the venue's `"Buffalo"`
// as the locality (or vice versa, depending on order). Composition therefore **emits labels
// directly** — venue tokens are unconditionally labeled `B-venue` / `I-venue`, and the address
// half re-uses the labels produced by aligning the un-composed address row in isolation. No
// re-search across the composed boundary.
//
// Why a separate primitive (not an `Augmentation`):
//
// - Augmentations are unary `(CanonicalRow) -> CanonicalRow | null` and run through
//   `synthesizeRow`. Composition is binary `(string, CanonicalRow) -> LabeledRow` and emits
//   `LabeledRow` directly (it cannot defer labels to alignment without the embedded-token bug).
// - Augmentations preserve provenance to a single source; compositions cite the address source
//   in `synth.base_source_id` and carry the venue surface form on the `venue` component.
// - Throttling (the issue calls for ~5-15% of training set) is a build-time policy, not an
//   adapter-level concern — the build pipeline applies it; the primitive stays pure.
//
// See `DECISIONS.md` for the rationale on why composition lives alongside augmentation but is
// not part of the `AUGMENTATIONS` registry.

/** Options accepted by `composeAdversarialRow`. */
export interface ComposeAdversarialOptions {
	/**
	 * Stable pattern label written into the emitted row's `synth.method` field (as `compose:<pattern>`). Free-form but
	 * should be one of a small set of canonical pattern names so downstream filtering / stratification can target
	 * individual patterns.
	 *
	 * Recommended values (Phase 1.6 §2.1):
	 *
	 * - `"place-name-venue"` — venue token shared with locality (`Buffalo Health Clinic, Buffalo NY`).
	 * - `"place-shaped-venue"` — venue contains a place-shaped substring (`New York, New York Steakhouse, Las Vegas NV`).
	 * - `"particle-honorific"` — apostrophe + St./Saint ambiguity (`P'tit St. Denis Street Café`).
	 */
	pattern: string

	/**
	 * Separator inserted between the venue and the address `raw`. Default `", "`. Single space (`" "`) produces the
	 * harder unpunctuated variant; newline (`"\n"`) the multi-line variant.
	 */
	separator?: string

	/**
	 * Tokenizer to apply to the venue prefix. Default `whitespaceTokenizer()`. The address half uses the same tokenizer
	 * when re-aligned — pass a consistent one if customizing.
	 */
	tokenizer?: Tokenizer
}

/** Either a successful labeled composition or a quarantined attempt. */
export type ComposeResult = { kind: "labeled"; row: LabeledRow } | { kind: "quarantined"; row: QuarantinedRow }

/**
 * Compose a venue string + an address row into a single adversarial `LabeledRow`.
 *
 * The emitted row's `raw` is `${venue}${separator}${address.raw}`. Tokens are produced by tokenizing the two halves
 * independently and concatenating; labels are venue tokens → `B-venue` / `I-venue` followed by the address's labels
 * (obtained by aligning the input address in isolation). This deterministic boundary is the entire point of the
 * primitive: the embedded place-shaped tokens in the venue stay labeled as `venue`, never as the address's locality /
 * region / etc., even when they share surface forms.
 *
 * The char-offset span triple (#519) is re-targeted to the composed surface by the same deterministic boundary: one
 * `venue` span over `[0, venue.length)` (no re-search), then the address's own spans shifted by `venue.length +
 * separator.length` — plain offset arithmetic, no token indirection. The separator chars sit outside every span
 * (deliberately unlabeled — now expressible). The composed triple is passed through `assertSpanInvariants` so a
 * composition bug can't ride into a corpus.
 *
 * The address's components are forwarded as-is (alignment ran on them and they survived); `venue` is added on top with
 * the trimmed venue string as its surface form.
 *
 * Returns `{ kind: "quarantined" }` when:
 *
 * - The venue is empty or whitespace-only.
 * - The venue is not NFC-normalized (char offsets over a non-NFC raw are ambiguous — the same discipline `alignRow`
 *   enforces on adapter rows, surfaced as quarantine here because the venue is caller-supplied data).
 * - The address row fails alignment in isolation (the underlying failure reason is propagated).
 */
export function composeAdversarialRow(
	venue: string,
	address: CanonicalRow,
	options: ComposeAdversarialOptions
): ComposeResult {
	const separator = options.separator ?? ", "
	const tokenizer = options.tokenizer ?? whitespaceTokenizer()

	const venueTrimmed = venue.trim()

	if (!venueTrimmed) {
		return { kind: "quarantined", row: { row: address, reason: "venue-empty" } }
	}

	// Char-offset spans over the composed raw are only meaningful under NFC (#519) — the address
	// half is enforced by alignRow; the venue is caller-supplied and checked here.
	if (venueTrimmed.normalize("NFC") !== venueTrimmed) {
		return { kind: "quarantined", row: { row: address, reason: "venue-not-nfc" } }
	}

	const addressAligned = alignRow(address, { tokenizer })

	if (addressAligned.kind !== "labeled") {
		// Surface the address's quarantine reason but tag it with the compose attempt for
		// debugging. The original CanonicalRow stays on the QuarantinedRow so callers can
		// inspect the address payload.
		return {
			kind: "quarantined",
			row: { row: address, reason: `compose-address-${addressAligned.row.reason}` },
		}
	}

	const venueTokens = tokenizer.tokenize(venueTrimmed)

	if (venueTokens.length === 0) {
		return { kind: "quarantined", row: { row: address, reason: "venue-no-tokens" } }
	}

	const venueLabels: BIOLabel[] = venueTokens.map((_, i) => (i === 0 ? "B-venue" : "I-venue"))

	const tokens: string[] = [...venueTokens.map((t) => t.text), ...addressAligned.row.tokens]
	const labels: BIOLabel[] = [...venueLabels, ...addressAligned.row.labels]

	const composedRaw = `${venueTrimmed}${separator}${address.raw}`
	const composedComponents = {
		venue: venueTrimmed,
		...address.components,
	}

	// Re-target the char-offset spans (#519) onto the composed surface: the venue span covers the
	// whole trimmed venue (internal punctuation included — the token path cannot say that), and the
	// address's spans shift right by the venue + separator length. alignRow emits the triple on
	// every labeled row, so absence here is an alignment-contract bug, not data — fail loudly.
	const { span_starts: addrStarts, span_ends: addrEnds, span_tags: addrTags } = addressAligned.row

	if (addrStarts === undefined || addrEnds === undefined || addrTags === undefined) {
		throw new Error(
			`composeAdversarialRow: alignRow returned a labeled row without the span triple ` +
				`(source=${address.source}, source_id=${address.source_id}) — alignment contract violation`
		)
	}
	const offset = venueTrimmed.length + separator.length
	const spans: ComponentSpan[] = [
		{ tag: "venue", start: 0, end: venueTrimmed.length },
		...addrTags.map((tag, i) => ({ tag, start: addrStarts[i]! + offset, end: addrEnds[i]! + offset })),
	]

	const baseSourceID = address.synth?.base_source_id ?? address.source_id
	const method = `compose:${options.pattern}`

	const composed: LabeledRow = {
		raw: composedRaw,
		components: composedComponents,
		country: address.country,
		locale: address.locale,
		source: address.source,
		source_id: `${address.source_id}+${method}`,
		corpus_version: address.corpus_version,
		license: address.license,
		synth: { method, base_source_id: baseSourceID },
		tokens,
		labels,
		span_starts: spans.map((s) => s.start),
		span_ends: spans.map((s) => s.end),
		span_tags: spans.map((s) => s.tag),
	}
	assertSpanInvariants(spans, composed)

	return { kind: "labeled", row: composed }
}
