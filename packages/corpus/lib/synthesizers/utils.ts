/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Synthesis and augmentation utilities.
 */

import type { BIOLabel, ComponentTag } from "@mailwoman/codex/component"
import {
	US_STREET_SUFFIX_PREFERRED_ABBR,
	US_UNIT_DESIGNATOR_PREFERRED_ABBR,
	matchCase,
	matchLeadingDesignator,
	matchTrailingSuffix,
} from "@mailwoman/codex/us"
import { isPresent } from "@mailwoman/core/objects"
import { mulberry32, sample } from "@mailwoman/core/random"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"
import { stripCombiningMarks } from "@mailwoman/normalize/fold"

import type { CanonicalRow, LabeledRow, QuarantinedRow } from "#types"
import { alignRow, assertSpanInvariants, type ComponentSpan } from "#utils/align"
import { whitespaceTokenizer, type Tokenizer } from "#utils/tokenize"

/**
 * A row augmentation.
 */
export type Augmentation = (row: CanonicalRow) => CanonicalRow | null

type ComponentDict = Partial<Record<ComponentTag, string>>

/**
 * Build an augmented row with synth metadata.
 */
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

// Locale-agnostic augmentations.

/**
 * Upper-case raw and components.
 */
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

/**
 * Lower-case raw and components.
 */
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

/**
 * Drop commas from raw.
 */
export const dropCommas: Augmentation = (row) => {
	if (!row.raw.includes(",")) return null
	const newRaw = row.raw.replaceAll(",", "").replaceAll(/\s+/g, " ").trim()

	return withAugmentation(row, "drop-commas", newRaw, { ...row.components })
}

/**
 * Double spaces in raw and components.
 */
export const doubleSpace: Augmentation = (row) => {
	if (!/ /.test(row.raw)) return null
	const newRaw = row.raw.replaceAll(" ", "  ")
	const newComponents: ComponentDict = {}

	for (const [k, v] of Object.entries(row.components)) {
		if (v) {
			newComponents[k as ComponentTag] = v.replaceAll(" ", "  ")
		}
	}

	return withAugmentation(row, "double-space", newRaw, newComponents)
}

/**
 * Strip accents/diacritics from raw and components.
 */
export const accentStrip: Augmentation = (row) => {
	const stripped = stripCombiningMarks(row.raw)

	if (stripped === row.raw) return null
	const newComponents: ComponentDict = {}

	for (const [k, v] of Object.entries(row.components)) {
		if (v) {
			newComponents[k as ComponentTag] = stripCombiningMarks(v)
		}
	}

	return withAugmentation(row, "accent-strip", stripped, newComponents)
}

// Typo helpers are deterministic per row.

/**
 * QWERTY adjacency for key-neighbor substitutions.
 */
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
 * Eligible typo target: letter-like name with length >= 4.
 */
const ALPHA_NAME = /^[\p{L}][\p{L} '.-]{3,}$/u

/**
 * Deterministic djb2 hash to uint32.
 */
function hashString(s: string): number {
	let h = 5381

	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
	}

	return h >>> 0
}

/**
 * Inject one deterministic typo into an eligible component.
 */
export const typoInject: Augmentation = (row) => {
	const rng = mulberry32(hashString(`${row.source_id}:typo`))

	// Only edit an unambiguous component value.
	const occurs = (needle: string): number => {
		let n = 0

		for (let i = row.raw.indexOf(needle); i >= 0; i = row.raw.indexOf(needle, i + needle.length)) {
			n++
		}

		return n
	}

	const values = Object.values(row.components).filter(isPresent)

	const eligible = (Object.entries(row.components) as Array<[ComponentTag, string]>).filter(
		([, v]) => v && ALPHA_NAME.test(v) && occurs(v) === 1 && !values.some((o) => o !== v && o.includes(v))
	)

	if (!eligible.length) return null
	const [tag, value] = sample(eligible, rng)
	// Interior letter positions only.
	const positions: number[] = []

	for (let i = 1; i < value.length - 1; i++)
		if (/\p{L}/u.test(value[i]!)) {
			positions.push(i)
		}

	if (!positions.length) return null
	const i = sample(positions, rng)
	const ch = value[i]!
	let typed: string

	if (rng() < 0.5) {
		const next = value[i + 1]!

		if (ch === next) return null
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

	// `replace(string, …)` updates the first literal match.
	return withAugmentation(row, "typo-inject", newRaw, { ...row.components, [tag]: typed })
}

// US-specific augmentations.

/**
 * US state full name -> alpha-2.
 */
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

/**
 * Expand state abbreviation to full name.
 */
export const stateExpand: Augmentation = (row) => {
	if (row.country !== "US") return null
	const region = row.components.region

	if (!region) return null
	const full = STATE_ABBR_TO_NAME[region]

	if (!full) return null
	// Replace exact word matches only.
	const re = new RegExp(`\\b${region}\\b`, "g")

	if (!re.test(row.raw)) return null
	const newRaw = row.raw.replaceAll(new RegExp(`\\b${region}\\b`, "g"), full)
	const newComponents: ComponentDict = { ...row.components, region: full }

	return withAugmentation(row, "state-expand", newRaw, newComponents)
}

/**
 * Abbreviate full state name to alpha-2.
 */
export const stateAbbreviate: Augmentation = (row) => {
	if (row.country !== "US") return null
	const region = row.components.region

	if (!region) return null
	const abbr = STATE_NAME_TO_ABBR[region]

	if (!abbr) return null
	const re = new RegExp(`\\b${region}\\b`, "g")

	if (!re.test(row.raw)) return null
	const newRaw = row.raw.replaceAll(new RegExp(`\\b${region}\\b`, "g"), abbr)
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

/**
 * Expand directional abbreviations.
 */
export const directionalExpand: Augmentation = (row) => {
	if (row.country !== "US") return null
	const tagsToCheck: ComponentTag[] = ["street", "street_suffix", "street_prefix"]
	let changed = false
	let newRaw = row.raw
	const newComponents: ComponentDict = { ...row.components }

	for (const tag of tagsToCheck) {
		const v = newComponents[tag]

		if (!v) continue
		const replaced = v.replaceAll(/\b(N|S|E|W|NE|NW|SE|SW)\b/g, (m) => DIRECTIONAL_ABBR_TO_FULL[m] ?? m)

		if (replaced !== v) {
			newComponents[tag] = replaced
			newRaw = newRaw.replaceAll(new RegExp(`\\b${escapeRegExp(v)}\\b`, "g"), replaced)
			changed = true
		}
	}

	if (!changed) return null

	return withAugmentation(row, "directional-expand", newRaw, newComponents)
}

/**
 * Abbreviate directional words.
 */
export const directionalAbbreviate: Augmentation = (row) => {
	if (row.country !== "US") return null
	const tagsToCheck: ComponentTag[] = ["street", "street_suffix", "street_prefix"]
	let changed = false
	let newRaw = row.raw
	const newComponents: ComponentDict = { ...row.components }

	for (const tag of tagsToCheck) {
		const v = newComponents[tag]

		if (!v) continue

		const replaced = v.replaceAll(
			/\b(North|South|East|West|Northeast|Northwest|Southeast|Southwest)\b/g,
			(m) => DIRECTIONAL_FULL_TO_ABBR[m] ?? m
		)

		if (replaced !== v) {
			newComponents[tag] = replaced
			newRaw = newRaw.replaceAll(new RegExp(`\\b${escapeRegExp(v)}\\b`, "g"), replaced)
			changed = true
		}
	}

	if (!changed) return null

	return withAugmentation(row, "directional-abbreviate", newRaw, newComponents)
}

/**
 * Abbreviate trailing US street suffix.
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
	const newRaw = row.raw.replaceAll(new RegExp(`\\b${escapeRegExp(street)}\\b`, "g"), newStreet)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "us-street-suffix-abbreviate", newRaw, newComponents)
}

/**
 * Expand trailing US street suffix.
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
	const newRaw = row.raw.replaceAll(new RegExp(`\\b${escapeRegExp(street)}\\b`, "g"), newStreet)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "us-street-suffix-expand", newRaw, newComponents)
}

/**
 * Abbreviate leading US unit designator.
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
	const newRaw = row.raw.replaceAll(new RegExp(`\\b${escapeRegExp(unit)}\\b`, "g"), newUnit)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "us-unit-designator-abbreviate", newRaw, newComponents)
}

/**
 * Expand leading US unit designator.
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
	const newRaw = row.raw.replaceAll(new RegExp(`\\b${escapeRegExp(unit)}\\b`, "g"), newUnit)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "us-unit-designator-expand", newRaw, newComponents)
}

/**
 * Drop dash from ZIP+4.
 */
export const zipPlus4DashDrop: Augmentation = (row) => {
	if (row.country !== "US") return null
	const postcode = row.components.postcode

	if (!postcode || !/^\d{5}-\d{4}$/.test(postcode)) return null
	const noDash = postcode.replace("-", "")
	const newRaw = row.raw.replace(postcode, noDash)

	if (newRaw === row.raw) return null

	return withAugmentation(row, "zip-plus4-dash-drop", newRaw, { ...row.components, postcode: noDash })
}

// French-specific augmentations.

/**
 * Drop French street particle.
 */
export const particleStrip: Augmentation = (row) => {
	if (row.country !== "FR") return null
	const particle = row.components.street_prefix_particle

	if (!particle) return null
	const newComponents: ComponentDict = { ...row.components }
	delete newComponents.street_prefix_particle
	// Remove particle and normalize spaces.
	const re = new RegExp(`\\s+${escapeRegExp(particle)}\\s+`, "g")

	if (!re.test(row.raw)) return null
	const newRaw = row.raw.replace(re, " ").replaceAll(/\s+/g, " ").trim()

	return withAugmentation(row, "particle-strip", newRaw, newComponents)
}

// Stable augmentation registry.

/**
 * Stable id -> augmentation function.
 */
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

/**
 * Default augmentations by country.
 */
export function defaultAugmentationsForCountry(country: string): readonly Augmentation[] {
	// `typoInject` is opt-in only.
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
 * Yield all non-null augmentation outputs.
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

/**
 * Weighted random pick from items.
 */
export function weightedPick<T>(
	items: readonly T[],
	random: () => number,
	weightOf: (item: T) => number,
	options: { inclusive?: boolean } = {}
): T {
	const inclusive = options.inclusive ?? true
	const total = items.reduce((sum, item) => sum + weightOf(item), 0)
	let r = random() * total

	for (const item of items) {
		r -= weightOf(item)

		if (inclusive ? r <= 0 : r < 0) return item
	}

	return items.at(-1)!
}

/**
 * One band in a tiered number distribution.
 */
export interface TieredNumberBand {
	cutoff?: number
	base: number
	span: number
}

/**
 * Draw a number from tiered bands.
 */
export function tieredNumber(random: () => number, bands: readonly TieredNumberBand[]): string {
	const r = random()
	let chosen = bands.at(-1)!

	for (const band of bands) {
		if (band.cutoff === undefined || r < band.cutoff) {
			chosen = band

			break
		}
	}

	return String(chosen.base + Math.floor(random() * chosen.span))
}

/**
 * Map country names/codes to default locale.
 */
export function countryToLocale(country: string): string {
	const c = country.trim().toUpperCase()

	if (c === "US" || c === "USA" || c === "UNITED STATES") return "en-US"

	if (c === "CA" || c === "CAN" || c === "CANADA") return "en-CA"

	if (c === "GB" || c === "UK" || c === "GBR" || c === "UNITED KINGDOM") return "en-GB"

	if (c === "AU" || c === "AUS" || c === "AUSTRALIA") return "en-AU"

	if (c === "NZ" || c === "NZL" || c === "NEW ZEALAND") return "en-NZ"

	if (c === "FR" || c === "FRA" || c === "FRANCE") return "fr-FR"

	if (c === "DE" || c === "DEU" || c === "GERMANY") return "de-DE"

	if (c === "ES" || c === "ESP" || c === "SPAIN") return "es-ES"

	if (c === "MX" || c === "MEX" || c === "MEXICO") return "es-MX"

	if (c === "AR" || c === "ARG" || c === "ARGENTINA") return "es-AR"

	return "en-US"
}

// Compositional synthesis combines a venue string and an address row.

/**
 * Options for `composeAdversarialRow`.
 */
export interface ComposeAdversarialOptions {
	/**
	 * Pattern name used in `synth.method` as `compose:<pattern>`.
	 */
	pattern: string

	/**
	 * Separator between venue and address raw.
	 * Default `", "`.
	 */
	separator?: string

	/**
	 * Tokenizer for venue and address alignment.
	 */
	tokenizer?: Tokenizer
}

/**
 * Successful composition or quarantine result.
 */
export type ComposeResult = { kind: "labeled"; row: LabeledRow } | { kind: "quarantined"; row: QuarantinedRow }

/**
 * Compose venue + address into a labeled adversarial row.
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

	// Venue must be NFC for stable char offsets.
	if (venueTrimmed.normalize("NFC") !== venueTrimmed) {
		return { kind: "quarantined", row: { row: address, reason: "venue-not-nfc" } }
	}

	const addressAligned = alignRow(address, { tokenizer })

	if (addressAligned.kind !== "labeled") {
		// Propagate address alignment failure with compose prefix.
		return {
			kind: "quarantined",
			row: { row: address, reason: `compose-address-${addressAligned.row.reason}` },
		}
	}

	const venueTokens = tokenizer.tokenize(venueTrimmed)

	if (!venueTokens.length) {
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

	// Shift address spans by venue + separator and prepend one venue span.
	const { span_starts: addrStarts, span_ends: addrEnds, span_tags: addrTags } = addressAligned.row

	if (addrStarts === undefined || addrEnds === undefined || addrTags === undefined) {
		throw new Error(
			`composeAdversarialRow: alignRow returned a labeled row without the span triple ` +
				`(source=${address.source}, source_id=${address.source_id}) — alignment interface violation`
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
