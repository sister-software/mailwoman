/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS Publication 28, Appendix C2, Secondary Unit Designators.
 *
 *   The sibling of {@link ./street-suffix.ts}. That table standardizes the trailing street _type_
 *   (avenue → AVE). This one standardizes the _secondary unit_ designator that introduces an
 *   apartment / suite / floor / room (apartment → APT, suite → STE). For each canonical designator
 *   the value lists recognized variants in USPS order. The first is the approved USPS abbreviation,
 *   the form the post office prints.
 *
 *   Used by `@mailwoman/corpus`'s synthesis layer (the `unit-{expand,abbreviate}` augmentations) to
 *   vary the designator in a `unit` component while preserving the identifier. Designators are
 *   leading ("Apt 4B"). Street suffixes trail.
 *
 *   `US_UNIT_DESIGNATOR_REQUIRES_RANGE` is Pub-28's own "Requires a Secondary Number" column. APT,
 *   bldg, dept, FL, hngr, KEY, LOT, pier, RM, slip, SPC, stop, STE, trlr and unit must be followed
 *   by an identifier ("Apt 4B"). bsmt, frnt, lbby, lowr, OFC, PH, rear, side and uppr may stand
 *   by itself. A separate deliverable is the per-locale *level-semantics* table (étage/RDC, EG/OG/UG,
 *   planta/piso/bajo, piano/terra, 階/F/B1, …). This module stays US/Pub-28 only.
 *
 *   Data is verbatim USPS Pub-28 C2.
 * @see {@link https://pe.usps.com/text/pub28/28apc_003.htm USPS Secondary Unit Designators}
 */

/**
 * Canonical USPS secondary unit designator → recognized variants.
 *
 * The first variant is the approved USPS abbreviation.
 */
export const US_UNIT_DESIGNATOR_VARIANTS = {
	APARTMENT: ["APT", "APRT", "APMT"],
	BASEMENT: ["BSMT"],
	BUILDING: ["BLDG", "BLD"],
	DEPARTMENT: ["DEPT"],
	FLOOR: ["FL", "FLR"],
	FRONT: ["FRNT"],
	HANGAR: ["HNGR"],
	KEY: ["KEY"],
	LOBBY: ["LBBY"],
	LOT: ["LOT"],
	LOWER: ["LOWR"],
	OFFICE: ["OFC"],
	PENTHOUSE: ["PH"],
	PIER: ["PIER"],
	REAR: ["REAR"],
	ROOM: ["RM"],
	SIDE: ["SIDE"],
	SLIP: ["SLIP"],
	SPACE: ["SPC"],
	STOP: ["STOP"],
	SUITE: ["STE", "SUIT"],
	TRAILER: ["TRLR"],
	UNIT: ["UNIT"],
	UPPER: ["UPPR"],
} as const satisfies Record<string, readonly string[]>

/**
 * Canonical USPS secondary unit designator (full word, uppercase per the publication).
 */
export type USUnitDesignator = keyof typeof US_UNIT_DESIGNATOR_VARIANTS

/**
 * Inverse lookup: every variant abbreviation or full canonical word → its canonical key,
 * built once at module load, lowercase-keyed for case-insensitive matching.
 */
export const US_UNIT_DESIGNATOR_LOOKUP: ReadonlyMap<string, USUnitDesignator> = (() => {
	const out = new Map<string, USUnitDesignator>()

	for (const canonical of Object.keys(US_UNIT_DESIGNATOR_VARIANTS) as USUnitDesignator[]) {
		out.set(canonical.toLowerCase(), canonical)

		for (const variant of US_UNIT_DESIGNATOR_VARIANTS[canonical]) {
			// First canonical that claims a variant wins (matches the publication's ordering).
			if (!out.has(variant.toLowerCase())) {
				out.set(variant.toLowerCase(), canonical)
			}
		}
	}

	return out
})()

/**
 * Approved USPS abbreviation per canonical (`apartment → "APT"`, `suite → "STE"`).
 */
export const US_UNIT_DESIGNATOR_PREFERRED_ABBR: Readonly<Record<USUnitDesignator, string>> = Object.fromEntries(
	(Object.keys(US_UNIT_DESIGNATOR_VARIANTS) as USUnitDesignator[]).map((k) => [k, US_UNIT_DESIGNATOR_VARIANTS[k][0]])
) as Readonly<Record<USUnitDesignator, string>>

/**
 * Canonical designators Appendix C2 marks as "Requires a Secondary Number".
 *
 * The designator must be followed by an identifier ("Apt 4B", "Rm 12").
 *
 * The remaining designators (basement, front, lobby, lower, office, penthouse, rear, side, upper)
 * may appear with no trailing identifier.
 * Verbatim from USPS Pub-28 C2.
 */
export const US_UNIT_DESIGNATOR_REQUIRES_RANGE: Readonly<Record<USUnitDesignator, boolean>> = {
	APARTMENT: true,
	BASEMENT: false,
	BUILDING: true,
	DEPARTMENT: true,
	FLOOR: true,
	FRONT: false,
	HANGAR: true,
	KEY: true,
	LOBBY: false,
	LOT: true,
	LOWER: false,
	OFFICE: false,
	PENTHOUSE: false,
	PIER: true,
	REAR: false,
	ROOM: true,
	SIDE: false,
	SLIP: true,
	SPACE: true,
	STOP: true,
	SUITE: true,
	TRAILER: true,
	UNIT: true,
	UPPER: false,
} as const satisfies Record<USUnitDesignator, boolean>

/**
 * If the first whitespace-separated word of `unit` is a known USPS designator variant,
 * return the canonical key and the matched word.
 *
 * @returns null if the leading word isn't a known designator (e.g. A bare `"4B"` or `"#210"`).
 */
export function matchLeadingDesignator(unit: string): { canonical: USUnitDesignator; matched: string } | null {
	const trimmed = unit.trim()

	if (!trimmed) return null
	const first = trimmed.split(/\s+/)[0]!
	const canonical = US_UNIT_DESIGNATOR_LOOKUP.get(first.toLowerCase())

	if (!canonical) return null

	return { canonical, matched: first }
}

/**
 * Result of {@link matchLeadingDesignatorWithRange}: the leading designator
 * plus its optional secondary range.
 */
export interface UnitDesignatorRangeMatch {
	canonical: USUnitDesignator
	matched: string
	/**
	 * The secondary range/identifier token immediately following the designator, i.e. "4B" in "Apt 4B".
	 *
	 * Undefined when the designator appears standalone (e.g. a bare "Basement").
	 * This module does not validate the range's own shape.
	 *
	 * Numeric, letter and alphanumeric ranges are all USPS-valid.
	 */
	range: string | undefined
	/**
	 * Whether USPS Pub-28 Appendix C2 marks this designator as requiring a secondary
	 * range (see {@link US_UNIT_DESIGNATOR_REQUIRES_RANGE}).
	 *
	 * Informational only.
	 * This matcher does not enforce it.
	 */
	requiresRange: boolean
}

/**
 * Like {@link matchLeadingDesignator}, but also captures the secondary range/identifier token
 * immediately following the designator, if present ("Apt 4B" → designator "apartment", range "4B").
 */
export function matchLeadingDesignatorWithRange(unit: string): UnitDesignatorRangeMatch | null {
	const trimmed = unit.trim()

	if (!trimmed) return null
	const parts = trimmed.split(/\s+/)
	const first = parts[0]!
	const canonical = US_UNIT_DESIGNATOR_LOOKUP.get(first.toLowerCase())

	if (!canonical) return null

	return {
		canonical,
		matched: first,
		range: parts[1],
		requiresRange: US_UNIT_DESIGNATOR_REQUIRES_RANGE[canonical],
	}
}

/**
 * Result of a successful USPS secondary-unit designator lookup.
 */
export interface UnitDesignatorMatch<D extends USUnitDesignator = USUnitDesignator> {
	designator: D
	/**
	 * The approved USPS abbreviation.
	 */
	abbreviation: (typeof US_UNIT_DESIGNATOR_VARIANTS)[D][0]
}

/**
 * Look up a USPS secondary unit designator (by canonical word, abbreviation, or any variant)
 * and its approved abbreviation.
 */
export function lookupUnitDesignator<D extends USUnitDesignator>(designator: D): UnitDesignatorMatch<D>
export function lookupUnitDesignator(input: string | null): UnitDesignatorMatch | null

export function lookupUnitDesignator(input: string | null): UnitDesignatorMatch | null {
	if (!input || typeof input !== "string") return null
	const designator = US_UNIT_DESIGNATOR_LOOKUP.get(input.trim().toLowerCase())

	if (!designator) return null

	return { designator, abbreviation: US_UNIT_DESIGNATOR_VARIANTS[designator][0] }
}

/**
 * True when a token is any USPS secondary unit designator or abbreviation, case-insensitive.
 */
export function isUnitDesignatorToken(input: unknown): boolean {
	return typeof input === "string" && US_UNIT_DESIGNATOR_LOOKUP.has(input.trim().toLowerCase())
}

/**
 * Alias of {@link isUnitDesignatorToken} under Pub-28's own term ("secondary unit designator").
 */
export function isSecondaryUnitDesignatorToken(input: unknown): boolean {
	return isUnitDesignatorToken(input)
}
