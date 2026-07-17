/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS Publication 28, Appendix C2 — Floor-class Secondary Unit Designators.
 *
 *   The sibling of {@link ./unit-designator.ts}: where the unit table covers the full secondary-unit
 *   vocabulary (APT, STE, RM, …), this module extracts the floor-class subset — designators that
 *   name a FLOOR or LEVEL of the building rather than a specific addressable unit on that floor.
 *   USPS Pub 28 Appendix C2 identifies these designators as requiring a secondary number: "FL" (the
 *   approved abbreviation for FLOOR). The publication gives `FLOOR` as the canonical designator
 *   with approved abbreviation `FL` and variant `FLR`; `BASEMENT` (`BSMT`), `PENTHOUSE` (`PH`), and
 *   `LOBBY` (`LBBY`) are the standalone-or-numbered floor-adjacent types also listed in Appendix
 *   C2.
 *
 *   Appendix C2 explicitly marks FLOOR, BASEMENT as requiring a secondary number (alongside APT,
 *   BLDG, etc.) while PENTHOUSE and LOBBY may stand alone. PH and LBBY are kept here (not just in
 *   {@link ./unit-designator.ts}) because the span proposer treats them as level-class hints —
 *   "LOBBY" and "PH" name a specific floor-analog, not a numbered unit, and the prior map routes
 *   `LEVEL_PHRASE` → `unit` (the schema carries no separate `level` tag).
 *
 *   This table drives the `levelDesignators` set in the span-proposer lexicon. The full
 *   secondary-unit designators (APT, STE, RM, …) remain in {@link ./unit-designator.ts}.
 *
 *   Data is verbatim USPS Pub 28 Appendix C2.
 * @see {@link https://pe.usps.com/text/pub28/28apc_003.htm USPS Publication 28 — Appendix C2: Secondary Unit Designators}
 */

/**
 * One USPS Pub 28 C2 floor-class designator row.
 *
 * `requiresNumber` mirrors the Appendix C2 classification: FLOOR and BASEMENT must be followed by a secondary number;
 * PENTHOUSE and LOBBY may stand alone.
 */
export interface USFloorDesignator {
	/** Full canonical designator (uppercase per the publication). */
	name: string
	/** Approved USPS abbreviation (what the post office prints on standardized mail). */
	abbreviation: string
	/** Additional recognized surface variants from Appendix C2. */
	variants: readonly string[]
	/**
	 * True when Appendix C2 marks this designator as "Requires a Secondary Number" (FLOOR, BASEMENT). False for
	 * standalone types (PENTHOUSE, LOBBY) that name a specific floor-analog without an identifier.
	 */
	requiresNumber: boolean
}

/**
 * USPS Pub 28 C2 floor-class secondary unit designators. Verbatim from the publication; see the module header for the
 * per-row provenance. Ordered with the most-common numbered form first.
 */
export const US_FLOOR_DESIGNATORS = [
	{ name: "FLOOR", abbreviation: "FL", variants: ["FLR"], requiresNumber: true },
	{ name: "BASEMENT", abbreviation: "BSMT", variants: [], requiresNumber: true },
	{ name: "PENTHOUSE", abbreviation: "PH", variants: [], requiresNumber: false },
	{ name: "LOBBY", abbreviation: "LBBY", variants: [], requiresNumber: false },
] as const satisfies readonly USFloorDesignator[]

/** A canonical USPS floor-class designator name. */
export type USFloorDesignatorName = (typeof US_FLOOR_DESIGNATORS)[number]["name"]

/**
 * Inverse lookup: every surface form (canonical name, approved abbreviation, or Appendix C2 variant) → its canonical
 * designator name. Lowercase-keyed for case-insensitive matching: `"fl"` → `"FLOOR"`, `"bsmt"` → `"BASEMENT"`, `"ph"` →
 * `"PENTHOUSE"`.
 */
export const US_FLOOR_DESIGNATOR_LOOKUP: ReadonlyMap<string, USFloorDesignatorName> = (() => {
	const out = new Map<string, USFloorDesignatorName>()

	for (const row of US_FLOOR_DESIGNATORS) {
		out.set(row.name.toLowerCase(), row.name)
		out.set(row.abbreviation.toLowerCase(), row.name)

		for (const v of row.variants) {
			if (!out.has(v.toLowerCase())) {
				out.set(v.toLowerCase(), row.name)
			}
		}
	}

	return out
})()

/**
 * All lowercase surface tokens for the floor-class designators — the set the span proposer populates `levelDesignators`
 * with when wiring the US codex slice. Includes canonical names, approved abbreviations, and Appendix C2 variants.
 */
export const US_FLOOR_DESIGNATOR_TOKENS: ReadonlySet<string> = new Set(US_FLOOR_DESIGNATOR_LOOKUP.keys())

/** Approved USPS abbreviation per canonical floor designator name. */
export const US_FLOOR_DESIGNATOR_PREFERRED_ABBR: Readonly<Record<USFloorDesignatorName, string>> = Object.fromEntries(
	US_FLOOR_DESIGNATORS.map((r) => [r.name, r.abbreviation])
) as Readonly<Record<USFloorDesignatorName, string>>

/**
 * Look up a USPS floor-class designator (by canonical name, abbreviation, or any Appendix C2 variant) and return the
 * canonical name + approved abbreviation. Returns null if the token isn't a recognized floor-class designator.
 */
export function lookupFloorDesignator(input: string | null | undefined): {
	designator: USFloorDesignatorName
	abbreviation: string
} | null {
	if (!input || typeof input !== "string") return null
	const designator = US_FLOOR_DESIGNATOR_LOOKUP.get(input.trim().toLowerCase())

	if (!designator) return null

	return { designator, abbreviation: US_FLOOR_DESIGNATOR_PREFERRED_ABBR[designator] }
}

/**
 * True when a token is a recognized USPS floor-class secondary unit designator (case-insensitive) — `"Floor"`, `"FL"`,
 * `"flr"`, `"bsmt"`, `"ph"`, `"lbby"`.
 */
export function isFloorDesignatorToken(input: unknown): boolean {
	return typeof input === "string" && US_FLOOR_DESIGNATOR_LOOKUP.has(input.trim().toLowerCase())
}
