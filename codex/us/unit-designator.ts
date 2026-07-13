/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS Publication 28, Appendix C2 — Secondary Unit Designators.
 *
 *   The sibling of {@link ./street-suffix.ts}: where that table standardizes the trailing street
 *   _type_ (AVENUE → AVE), this one standardizes the _secondary unit_ designator that introduces an
 *   apartment / suite / floor / room (APARTMENT → APT, SUITE → STE). For each canonical designator
 *   the value lists recognized variants in USPS order; the first is the approved USPS abbreviation
 *   (what the post office prints).
 *
 *   Used by `@mailwoman/corpus`'s synthesis layer (the `unit-{expand,abbreviate}` augmentations) to
 *   vary the designator in a `unit` component while preserving the identifier — the data-generation
 *   counterpart to the runtime `UnitDesignatorClassifier` (which matches the broader libpostal
 *   `unit_types` lexicon). Designators are LEADING ("Apt 4B"), unlike street suffixes which trail.
 *
 *   `US_UNIT_DESIGNATOR_REQUIRES_RANGE` (added for #1100, the secondary-address epic; retrieved from
 *   Appendix C2 2026-07-13) is Pub-28's own "Requires a Secondary Number" column: APT, BLDG, DEPT,
 *   FL, HNGR, KEY, LOT, PIER, RM, SLIP, SPC, STOP, STE, TRLR, and UNIT must be followed by an
 *   identifier ("Apt 4B", never bare "Apt"); BSMT, FRNT, LBBY, LOWR, OFC, PH, REAR, SIDE, and UPPR
 *   may stand alone. This formalizes, as provenance-tracked reference data, the split that
 *   `corpus/src/shard-recipes/unit.ts` previously hand-rolled (and only partially covered) as
 *   in-file `ID_DESIGNATORS`/`STANDALONE_DESIGNATORS` arrays for synthesis weighting. A SEPARATE,
 *   not-yet-built deliverable of #1100 is the per-locale *level-semantics* table (étage/RDC, EG/OG/UG,
 *   planta/piso/bajo, piano/terra, 階/F/B1, …) — this module stays US/Pub-28 only.
 *
 *   Data is verbatim USPS Pub-28 C2.
 * @see {@link https://pe.usps.com/text/pub28/28apc_003.htm USPS Secondary Unit Designators}
 */

/**
 * Canonical USPS secondary unit designator → recognized variants. The first variant is the approved USPS abbreviation.
 * Keys + values uppercase per the publication. The designators marked by USPS as "requires a secondary number" (APT,
 * BLDG, FL, …) and the standalone ones (BSMT, LBBY, PH, …) are both included — synthesis treats them uniformly.
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

/** Canonical USPS secondary unit designator (full word, uppercase per the publication). */
export type UsUnitDesignator = keyof typeof US_UNIT_DESIGNATOR_VARIANTS

/**
 * Inverse lookup: every variant abbreviation OR full canonical word → its canonical key, built once at module load,
 * lowercase-keyed for case-insensitive matching (`apt` → `"APARTMENT"`, `ste` → `"SUITE"`, `suite` → `"SUITE"`).
 */
export const US_UNIT_DESIGNATOR_LOOKUP: ReadonlyMap<string, UsUnitDesignator> = (() => {
	const out = new Map<string, UsUnitDesignator>()

	for (const canonical of Object.keys(US_UNIT_DESIGNATOR_VARIANTS) as UsUnitDesignator[]) {
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

/** Approved USPS abbreviation per canonical (`APARTMENT → "APT"`, `SUITE → "STE"`). */
export const US_UNIT_DESIGNATOR_PREFERRED_ABBR: Readonly<Record<UsUnitDesignator, string>> = Object.fromEntries(
	(Object.keys(US_UNIT_DESIGNATOR_VARIANTS) as UsUnitDesignator[]).map((k) => [k, US_UNIT_DESIGNATOR_VARIANTS[k][0]])
) as Readonly<Record<UsUnitDesignator, string>>

/**
 * Canonical designators Appendix C2 marks as "Requires a Secondary Number" — the designator must be followed by an
 * identifier ("Apt 4B", "Rm 12"), never appearing bare. The remaining designators (BASEMENT, FRONT, LOBBY, LOWER,
 * OFFICE, PENTHOUSE, REAR, SIDE, UPPER) may stand alone with no trailing identifier. Verbatim from USPS Pub-28 C2; see
 * the module header for provenance (#1100).
 */
export const US_UNIT_DESIGNATOR_REQUIRES_RANGE: Readonly<Record<UsUnitDesignator, boolean>> = {
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
} as const satisfies Record<UsUnitDesignator, boolean>

/**
 * If the FIRST whitespace-separated word of `unit` is a known USPS designator variant, return the canonical key and the
 * matched word. Returns null if the leading word isn't a known designator (e.g. a bare `"4B"` or `"#210"`).
 * Leading-word-only — designators introduce the unit, unlike street suffixes which trail.
 */
export function matchLeadingDesignator(unit: string): { canonical: UsUnitDesignator; matched: string } | null {
	const trimmed = unit.trim()

	if (!trimmed) return null
	const first = trimmed.split(/\s+/)[0]!
	const canonical = US_UNIT_DESIGNATOR_LOOKUP.get(first.toLowerCase())

	if (!canonical) return null

	return { canonical, matched: first }
}

/** Result of {@link matchLeadingDesignatorWithRange}: the leading designator plus its optional secondary range. */
export interface UnitDesignatorRangeMatch {
	/** The matched canonical designator, i.e. "APARTMENT", "SUITE". */
	canonical: UsUnitDesignator
	/** The designator's own matched surface form, i.e. "Apt". */
	matched: string
	/**
	 * The secondary range/identifier token immediately following the designator, i.e. "4B" in "Apt 4B". Undefined when
	 * the designator appears standalone (e.g. bare "Basement"). This module does not validate the range's own shape —
	 * numeric, letter, or alphanumeric ranges are all USPS-valid.
	 */
	range: string | undefined
	/**
	 * Whether USPS Pub-28 Appendix C2 marks this designator as requiring a secondary range (see
	 * {@link US_UNIT_DESIGNATOR_REQUIRES_RANGE}). Informational only — not enforced by this matcher.
	 */
	requiresRange: boolean
}

/**
 * Like {@link matchLeadingDesignator}, but also captures the secondary range/identifier token immediately following the
 * designator, if present ("Apt 4B" → designator "APARTMENT", range "4B"; "Basement" → range `undefined`). Mirrors
 * `street-suffix`/`street-directional`'s designator+adjacent-token matchers.
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

/** Result of a successful USPS secondary-unit designator lookup. */
export interface UnitDesignatorMatch<D extends UsUnitDesignator = UsUnitDesignator> {
	/** The matched canonical designator, i.e. "APARTMENT", "SUITE". */
	designator: D
	/** The approved USPS abbreviation, i.e. "APT", "STE". */
	abbreviation: (typeof US_UNIT_DESIGNATOR_VARIANTS)[D][0]
}

/**
 * Look up a USPS secondary unit designator (by canonical word, abbreviation, or any variant) and its approved
 * abbreviation.
 */
export function lookupUnitDesignator<D extends UsUnitDesignator>(designator: D): UnitDesignatorMatch<D>
export function lookupUnitDesignator(input: string | null | undefined): UnitDesignatorMatch | null
export function lookupUnitDesignator(input: string | null | undefined): UnitDesignatorMatch | null {
	if (!input || typeof input !== "string") return null
	const designator = US_UNIT_DESIGNATOR_LOOKUP.get(input.trim().toLowerCase())

	if (!designator) return null

	return { designator, abbreviation: US_UNIT_DESIGNATOR_VARIANTS[designator][0] }
}

/**
 * True when a token is any USPS secondary unit designator or abbreviation (case-insensitive) — `"Apt"`, `"STE"`,
 * `"floor"`.
 */
export function isUnitDesignatorToken(input: unknown): boolean {
	return typeof input === "string" && US_UNIT_DESIGNATOR_LOOKUP.has(input.trim().toLowerCase())
}

/**
 * Alias of {@link isUnitDesignatorToken} under Pub-28's own term ("secondary unit designator"). Added for #1100 so
 * secondary-address call sites can spell the predicate after the publication's vocabulary.
 */
export function isSecondaryUnitDesignatorToken(input: unknown): boolean {
	return isUnitDesignatorToken(input)
}
