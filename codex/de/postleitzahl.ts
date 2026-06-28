/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   German postal codes (Postleitzahl, PLZ): the branded type, the shape, normalization, and the
 *   first-digit → Leitzone geographic prior.
 *
 *   The US analog is `us/zipcode.ts`, and the contrast is the informative part. A US ZIP's first
 *   digit maps cleanly to a band of states (`StateAbbreviationZipCodePrefixRecord`). A German PLZ's
 *   first digit maps to a **Leitzone** — a postal routing region that deliberately **crosses
 *   Bundesland borders** (Leitzone 6 covers Frankfurt in Hessen, Saarbrücken in Saarland, and Mainz
 *   in Rheinland-Pfalz). So the PLZ prior narrows geography, but it does NOT narrow the state the
 *   way a US ZIP does — a lesson for any code that tries to derive a German region from a postcode
 *   alone.
 */

import type { Tagged } from "type-fest"

/**
 * A German postal code: five digits since the 1993 reform (`12623`). A bare 5-digit string, same shape as a US ZIP or a
 * French code postal — disambiguation is the parser's job, not the shape's.
 *
 * @category Postal
 * @type string
 * @title Postleitzahl
 * @pattern ^\d{5}$
 */
export type Postleitzahl = Tagged<string, "Postleitzahl">

/** The PLZ shape: exactly five digits. */
export const PLZ_PATTERN = /^\d{5}$/

/**
 * Normalize a PLZ surface form to the bare five digits: strip the `D-` / `DE-` country courtesy prefix and surrounding
 * whitespace (`D-68161` → `68161`). Returns null if the result is not a PLZ.
 */
export function normalizePLZ(raw: unknown): Postleitzahl | null {
	if (typeof raw !== "string") return null
	const s = raw.trim().toUpperCase().replace(/^DE?-/, "")

	return PLZ_PATTERN.test(s) ? (s as Postleitzahl) : null
}

/** Type-predicate for a (normalized) German postal code. */
export function isPostleitzahl(input: unknown): input is Postleitzahl {
	return typeof input === "string" && PLZ_PATTERN.test(input)
}

/** A PLZ Leitzone first digit. */
export type LeitzoneDigit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Per-Leitzone descriptor: the routing region and a few anchor cities (coarse, postal not admin). */
export interface LeitzoneInfo {
	digit: LeitzoneDigit
	/** Coarse routing-region label. */
	region: string
	/** Well-known anchor cities in the zone (illustrative, not exhaustive). */
	cities: readonly string[]
}

/**
 * PLZ first digit → Leitzone. A coarse, postal-routing prior: these zones cross Bundesland borders, so the label is
 * "which corner of Germany", not "which state". Anchor cities are the safe, well-known way to pin a zone without
 * over-claiming a boundary the routing geography does not actually follow.
 */
export const PLZ_LEITZONEN = {
	0: { digit: 0, region: "Sachsen / Ostthüringen", cities: ["Leipzig", "Dresden", "Chemnitz"] },
	1: { digit: 1, region: "Berlin / Brandenburg / Mecklenburg-Vorpommern", cities: ["Berlin", "Potsdam", "Rostock"] },
	2: { digit: 2, region: "Hamburg / Schleswig-Holstein / Bremen", cities: ["Hamburg", "Kiel", "Bremen"] },
	3: { digit: 3, region: "Niedersachsen / Nordhessen", cities: ["Hannover", "Braunschweig", "Kassel"] },
	4: { digit: 4, region: "nördliches Nordrhein-Westfalen", cities: ["Düsseldorf", "Dortmund", "Münster"] },
	5: { digit: 5, region: "südliches NRW / nördliches Rheinland-Pfalz", cities: ["Köln", "Bonn", "Aachen"] },
	6: {
		digit: 6,
		region: "Südhessen / Rheinland-Pfalz / Saarland",
		cities: ["Frankfurt am Main", "Mainz", "Saarbrücken"],
	},
	7: { digit: 7, region: "Baden-Württemberg", cities: ["Stuttgart", "Karlsruhe", "Freiburg"] },
	8: { digit: 8, region: "südliches Bayern", cities: ["München", "Augsburg", "Ingolstadt"] },
	9: { digit: 9, region: "nördliches Bayern / Oberpfalz", cities: ["Nürnberg", "Würzburg", "Regensburg"] },
} as const satisfies Record<LeitzoneDigit, LeitzoneInfo>

/** The Leitzone of a PLZ (its first digit's routing region), or null if the input is not a PLZ. */
export function leitzoneOf(plz: unknown): LeitzoneInfo | null {
	const normalized = normalizePLZ(plz)

	if (!normalized) return null

	return PLZ_LEITZONEN[Number(normalized[0]) as LeitzoneDigit]
}
