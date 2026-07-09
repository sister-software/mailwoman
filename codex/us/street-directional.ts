/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS street **directionals** — the 8 cardinal/intercardinal prefixes (N, S, E, W, NE, NW, SE,
 *   SW). The leading-directional counterpart to {@link ./street-suffix.ts} (trailing street type):
 *   "N Main St" splits into a `street_prefix` directional ("N"), a `street` name ("Main"), and a
 *   `street_suffix` type ("St").
 * @see {@link https://pe.usps.com/text/pub28/28apc_002.htm USPS Pub 28 Appendix C1}
 */

import { matchCase } from "./street-suffix.ts"

/**
 * The 8 directional abbreviations accepted by the USPS. The USPS prefers the abbreviation over the fully-spelled-out
 * name.
 */
export const DirectionalAbbreviation = {
	NORTH: "N",
	EAST: "E",
	SOUTH: "S",
	WEST: "W",
	NORTHEAST: "NE",
	NORTHWEST: "NW",
	SOUTHEAST: "SE",
	SOUTHWEST: "SW",
} as const

export type DirectionalAbbreviation = (typeof DirectionalAbbreviation)[keyof typeof DirectionalAbbreviation]

/** The 8 directional names accepted by the USPS (intercardinals spaced, per the publication). */
export const DirectionalNames = [
	"NORTH",
	"EAST",
	"SOUTH",
	"WEST",
	"NORTH EAST",
	"NORTH WEST",
	"SOUTH EAST",
	"SOUTH WEST",
] as const satisfies readonly string[]

export type DirectionalName = (typeof DirectionalNames)[number]

export const DirectionalNameVariations = [
	...DirectionalNames,
	// Without spaces (the common US street form: "Northeast Main St")…
	"NORTHEAST",
	"NORTHWEST",
	"SOUTHEAST",
	"SOUTHWEST",
	// Title-case…
	"North",
	"East",
	"South",
	"West",
	"North East",
	"North West",
	"South East",
	"South West",
	"Northeast",
	"Northwest",
	"Southeast",
	"Southwest",
	// Lower-case…
	"north east",
	"north west",
	"south east",
	"south west",
	"northeast",
	"northwest",
	"southeast",
	"southwest",
] as const satisfies readonly string[]

export type DirectionalNameVariation = (typeof DirectionalNameVariations)[number]

/**
 * Abbreviation → full name.
 */
export const DirectionalAbbreviationRecord = {
	N: "NORTH",
	E: "EAST",
	S: "SOUTH",
	W: "WEST",
	NE: "NORTH EAST",
	NW: "NORTH WEST",
	SE: "SOUTH EAST",
	SW: "SOUTH WEST",
} as const satisfies Record<DirectionalAbbreviation, DirectionalName>

export type DirectionalAbbreviationRecord = typeof DirectionalAbbreviationRecord

/**
 * Name (and its variations) → abbreviation.
 */
export const DirectionAbbreviationRecord = {
	NORTH: DirectionalAbbreviation.NORTH,
	EAST: DirectionalAbbreviation.EAST,
	SOUTH: DirectionalAbbreviation.SOUTH,
	WEST: DirectionalAbbreviation.WEST,
	NORTHEAST: DirectionalAbbreviation.NORTHEAST,
	NORTHWEST: DirectionalAbbreviation.NORTHWEST,
	SOUTHEAST: DirectionalAbbreviation.SOUTHEAST,
	SOUTHWEST: DirectionalAbbreviation.SOUTHWEST,
	"NORTH EAST": DirectionalAbbreviation.NORTHEAST,
	"NORTH WEST": DirectionalAbbreviation.NORTHWEST,
	"SOUTH EAST": DirectionalAbbreviation.SOUTHEAST,
	"SOUTH WEST": DirectionalAbbreviation.SOUTHWEST,
} as const satisfies Partial<Record<string, DirectionalAbbreviation>>

export type DirectionAbbreviationRecord = typeof DirectionAbbreviationRecord

/**
 * Abbreviation (verbatim or normalized) → full name.
 */
export const AbbreviationToDirectional: ReadonlyMap<string, DirectionalName> = new Map(
	Object.entries(DirectionalAbbreviationRecord)
)

/**
 * Name (verbatim or normalized) → abbreviation.
 */
export const DirectionalToAbbreviationMap: ReadonlyMap<string, DirectionalAbbreviation> = new Map(
	Object.entries(DirectionAbbreviationRecord)
)

/**
 * Given a possible directional abbreviation, return the corresponding full name (or null).
 */
export function pluckDirectionalName(input: unknown): DirectionalName | null {
	if (!input || typeof input !== "string") return null

	return AbbreviationToDirectional.get(input) || AbbreviationToDirectional.get(input.trim().toUpperCase()) || null
}

/**
 * Given a possible directional name, return the corresponding abbreviation (or null).
 */
export function lookupDirectionalAbbreviation(input: unknown): DirectionalAbbreviation | null {
	if (!input || typeof input !== "string") return null

	return (
		DirectionalToAbbreviationMap.get(input) ||
		DirectionalToAbbreviationMap.get(input.trim().toUpperCase().replace(/\s+/g, " ")) ||
		null
	)
}

/**
 * Result of a directional lookup: the canonical full name + its preferred abbreviation.
 */
export interface DirectionalMatch {
	/** The matched directional name, e.g. "NORTH", "NORTH EAST". */
	directional: DirectionalName
	/** The corresponding USPS abbreviation, e.g. "N", "NE". */
	abbreviation: DirectionalAbbreviation
}

/**
 * Look up a directional by abbreviation OR name (any variation), returning both forms.
 */
export function lookupDirectional(input: unknown): DirectionalMatch | null {
	if (!input || typeof input !== "string") return null
	const abbreviation = lookupDirectionalAbbreviation(input)

	if (abbreviation) return { directional: DirectionalAbbreviationRecord[abbreviation], abbreviation }
	const directional = pluckDirectionalName(input)

	if (directional) return { directional, abbreviation: DirectionalToAbbreviationMap.get(directional)! }

	return null
}

// ── Codex shard-facing helpers (mirror street-suffix's matchTrailingSuffix) ───────────────────────

/**
 * If the FIRST whitespace-separated word of `street` is a known USPS directional (abbrev or name), return the canonical
 * name, its abbreviation, and the matched surface word. Null otherwise. (The leading-end counterpart of
 * {@link matchTrailingSuffix}; mirrors unit-designator's `matchLeadingDesignator`.) Single-word only — the spaced "NORTH
 * EAST" form is normalized to its one-word variant in real US streets, which this matches via the lookup.
 */
export function matchLeadingDirectional(
	street: string
): { canonical: DirectionalName; abbreviation: DirectionalAbbreviation; matched: string } | null {
	const trimmed = street.trim()

	if (!trimmed) return null
	const first = trimmed.split(/\s+/)[0]!
	const m = lookupDirectional(first)

	if (!m) return null

	return { canonical: m.directional, abbreviation: m.abbreviation, matched: first }
}

/**
 * Render a directional in the requested surface form, in `reference`'s case pattern:
 *
 * - `"abbr"` → the USPS abbreviation ("N", "NE").
 * - `"full"` → the one-word spelled-out form ("North", "Northeast") — the common US street form, not the publication's
 *   spaced "NORTH EAST".
 */
export function renderDirectional(
	match: { canonical: DirectionalName; abbreviation: DirectionalAbbreviation },
	form: "abbr" | "full",
	reference: string
): string {
	const target = form === "abbr" ? match.abbreviation : match.canonical.replace(/\s+/g, "")

	return matchCase(target, reference)
}

/**
 * Case-insensitive check: is the token any USPS directional or abbreviation (`"N"`, `"north"`, `"NW"`)?
 */
export function isStreetDirectionalToken(input: unknown): boolean {
	return lookupDirectional(typeof input === "string" ? input.trim() : input) !== null
}
