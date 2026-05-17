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
 *   Phase 1 implements the locale-agnostic + most useful US/FR augmentations. Typo injection and
 *   other stochastic augmentations are intentionally deferred — they need a seed-aware API and are
 *   most useful at training time, not corpus build time.
 */

import type { ComponentTag } from "@mailwoman/core/types"
import { US_STREET_SUFFIX_PREFERRED_ABBR, matchCase, matchTrailingSuffix } from "./codex/us-street-suffix.js"
import type { CanonicalRow } from "./types.js"

/**
 * An augmentation transforms a single row. Return `null` if the augmentation doesn't apply (e.g.
 * accent-strip on a row that has no accents; particle-strip on a US row).
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
	const baseId = source.synth?.base_source_id ?? source.source_id
	return {
		...source,
		raw: newRaw,
		components: newComponents,
		source_id: `${source.source_id}+${method}`,
		synth: { method, base_source_id: baseId },
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
		if (v) upComponents[k as ComponentTag] = v.toUpperCase()
	}
	return withAugmentation(row, "case-upper", upRaw, upComponents)
}

/** Lower-case raw + every component value. Returns null if already all-lower. */
export const caseLower: Augmentation = (row) => {
	if (row.raw === row.raw.toLowerCase()) return null
	const downRaw = row.raw.toLowerCase()
	const downComponents: ComponentDict = {}
	for (const [k, v] of Object.entries(row.components)) {
		if (v) downComponents[k as ComponentTag] = v.toLowerCase()
	}
	return withAugmentation(row, "case-lower", downRaw, downComponents)
}

/** Drop commas from `raw`. Components unchanged (they didn't carry commas). */
export const dropCommas: Augmentation = (row) => {
	if (!row.raw.includes(",")) return null
	const newRaw = row.raw.replace(/,/g, "").replace(/\s+/g, " ").trim()
	return withAugmentation(row, "drop-commas", newRaw, { ...row.components })
}

/** Replace single spaces with double spaces in `raw`. Components unchanged. */
export const doubleSpace: Augmentation = (row) => {
	if (!/ /.test(row.raw)) return null
	const newRaw = row.raw.replace(/ /g, "  ")
	return withAugmentation(row, "double-space", newRaw, { ...row.components })
}

/**
 * Strip Unicode combining marks (accents, diacritics) from raw + components. "Hôtel" → "Hotel";
 * "Île-de-France" → "Ile-de-France". Returns null if the row has no accents.
 */
export const accentStrip: Augmentation = (row) => {
	const stripped = stripAccents(row.raw)
	if (stripped === row.raw) return null
	const newComponents: ComponentDict = {}
	for (const [k, v] of Object.entries(row.components)) {
		if (v) newComponents[k as ComponentTag] = stripAccents(v)
	}
	return withAugmentation(row, "accent-strip", stripped, newComponents)
}

function stripAccents(s: string): string {
	return s.normalize("NFD").replace(/\p{M}/gu, "")
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
 * US: swap the trailing street-suffix word in `components.street` to its preferred USPS
 * abbreviation, preserving case. `"5th Avenue"` → `"5th Ave"`; `"5TH AVENUE"` → `"5TH AVE"`; `"main
 * street"` → `"main st"`. Returns null when no trailing suffix is recognized, when the trailing
 * word is already the preferred abbreviation, or when the swap would leave `raw` un- touched
 * (alignment requires both raw and components to move in lockstep).
 *
 * Targets the trailing word only to avoid mangling streets like "Avenue of the Americas" where the
 * suffix-shaped word is part of the proper name rather than a USPS suffix.
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
 * US: swap the trailing street-suffix word in `components.street` to its full canonical form,
 * preserving case. `"5th Ave"` → `"5th Avenue"`; `"5TH AVE"` → `"5TH AVENUE"`; `"main st"` → `"main
 * street"`. Returns null when no trailing suffix is recognized, when the trailing word is already
 * the canonical full form, or when the swap would leave `raw` untouched.
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
	"zip-plus4-dash-drop": zipPlus4DashDrop,
	"particle-strip": particleStrip,
}

/** Default augmentation set, by country. Phase 1: US + FR; others get the locale-agnostic set. */
export function defaultAugmentationsForCountry(country: string): readonly Augmentation[] {
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
				zipPlus4DashDrop,
			]
		case "FR":
			return [...universal, accentStrip, particleStrip]
		default:
			return universal
	}
}

/**
 * Run every augmentation against a row; collect the non-null outputs. The augmentations are pure,
 * so callers can compose them off this generator (e.g. nesting accent-strip ∘ state-abbreviate).
 */
export function* synthesizeRow(
	row: CanonicalRow,
	augmentations: readonly Augmentation[] = defaultAugmentationsForCountry(row.country)
): Generator<CanonicalRow> {
	for (const aug of augmentations) {
		const out = aug(row)
		if (out) yield out
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
