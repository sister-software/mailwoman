/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australian floor designators such as `Level 3`, `L 12`, `Ground Floor` and `Mezzanine`.
 *
 *   The codes come from the level-type table in AS 4590.1-2017, which is also the vocabulary of the GNAF
 *   `LEVEL_TYPE_CODE` column. Australia Post AMAS approves `L` as the abbreviation for `Level`. Informal
 *   variants such as `LVL` come from OpenAddresses data, and the parser recognizes them.
 *
 * @see {@link https://auspost.com.au/sending/guidelines/addressing-guidelines Australia Post addressing guidelines}
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/correct-addressing.pdf Australia Post Correct Addressing brochure (Nov 2022)}
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf Australia Post barcode addressing booklet}
 * @see {@link https://www.iso.org/standard/67840.html AS 4590.1-2017 — Interchange of client information}
 */

/**
 * One AS 4590.1 level-type row.
 */
export interface AuLevelDesignator {
	/**
	 * The AS 4590.1 `LEVEL_TYPE_CODE`.
	 */
	code: string
	/**
	 * The full type name.
	 */
	name: string
	/**
	 * The abbreviation written on mail, such as "L".
	 */
	abbreviation: string
	/**
	 * Whether the designator must be followed by a floor identifier, as in `level 3`.
	 *
	 * Types such as `ground` and `rooftop` stand alone.
	 */
	requiresNumber: boolean
}

/**
 * The AS 4590.1-2017 level-type table.
 *
 * Matching tries rows in this order, so the most common types come first.
 */
export const AU_LEVEL_DESIGNATORS = [
	{ code: "L", name: "LEVEL", abbreviation: "L", requiresNumber: true },
	{ code: "G", name: "GROUND", abbreviation: "G", requiresNumber: false },
	{ code: "B", name: "BASEMENT", abbreviation: "B", requiresNumber: true },
	{ code: "M", name: "MEZZANINE", abbreviation: "M", requiresNumber: false },
	{ code: "LG", name: "LOWER GROUND", abbreviation: "LG", requiresNumber: false },
	{ code: "UG", name: "UPPER GROUND", abbreviation: "UG", requiresNumber: false },
	{ code: "OD", name: "OBSERVATION DECK", abbreviation: "OD", requiresNumber: false },
	{ code: "P", name: "PARKING", abbreviation: "P", requiresNumber: true },
	{ code: "RT", name: "ROOFTOP", abbreviation: "RT", requiresNumber: false },
] as const satisfies readonly AuLevelDesignator[]

/**
 * An AS 4590.1 `LEVEL_TYPE_CODE`.
 */
export type AuLevelCode = (typeof AU_LEVEL_DESIGNATORS)[number]["code"]

/**
 * The spellings recognized for each level code.
 *
 * The first entry is the canonical abbreviation and is the only one synthesis should use.
 * Recognition accepts every entry.
 */
export const AU_LEVEL_DESIGNATOR_VARIANTS: Readonly<Record<AuLevelCode, readonly string[]>> = {
	L: ["L", "LEVEL", "LVL", "LEVL", "LEV"],
	G: ["G", "GROUND", "GRD", "GF", "GROUND FLOOR"],
	B: ["B", "BASEMENT", "BSMT", "LOWER LEVEL"],
	M: ["M", "MEZZANINE", "MEZZ", "MEZZANINE LEVEL"],
	LG: ["LG", "LOWER GROUND", "LOWER GROUND FLOOR"],
	UG: ["UG", "UPPER GROUND", "UPPER GROUND FLOOR"],
	OD: ["OD", "OBSERVATION DECK"],
	P: ["P", "PARKING", "PODIUM"],
	RT: ["RT", "ROOFTOP", "ROOF"],
}

/**
 * Maps each lowercased variant to its level code, so `"bsmt"` maps to `"B"`.
 */
export const AU_LEVEL_DESIGNATOR_LOOKUP: ReadonlyMap<string, AuLevelCode> = (() => {
	// A code with no variants or a blank variant throws at module load.
	for (const { code } of AU_LEVEL_DESIGNATORS) {
		const variants = AU_LEVEL_DESIGNATOR_VARIANTS[code]

		if (!variants || !variants.length) {
			throw new Error(`[codex/au/level-designator] code "${code}" has no variants in AU_LEVEL_DESIGNATOR_VARIANTS`)
		}

		for (const v of variants) {
			if (!v || !v.trim()) {
				throw new Error(
					`[codex/au/level-designator] code "${code}" has an empty or blank variant in AU_LEVEL_DESIGNATOR_VARIANTS`
				)
			}
		}
	}

	const out = new Map<string, AuLevelCode>()

	for (const { code } of AU_LEVEL_DESIGNATORS) {
		for (const variant of AU_LEVEL_DESIGNATOR_VARIANTS[code]) {
			const key = variant.toLowerCase()

			if (!out.has(key)) {
				out.set(key, code)
			}
		}
	}

	return out
})()

/**
 * A parsed Australian level designator.
 */
export interface AuLevelDesignatorMatch {
	/**
	 * The designator as written, such as "lvl".
	 */
	matched: string
	/**
	 * The level code, such as "L".
	 */
	code: AuLevelCode
	/**
	 * The floor identifier, when present, such as "3" or "B2".
	 */
	identifier?: string
}

/**
 * One regular expression per level code.
 *
 * Variants are sorted longest first so that "ground floor" matches before "ground".
 */
const LEVEL_MATCHERS: ReadonlyArray<{ code: AuLevelCode; requiresNumber: boolean; re: RegExp }> = (() => {
	const rows: Array<{ code: AuLevelCode; requiresNumber: boolean; re: RegExp }> = []

	for (const { code, requiresNumber } of AU_LEVEL_DESIGNATORS) {
		const variants = [...AU_LEVEL_DESIGNATOR_VARIANTS[code]]
			.toSorted((a, b) => b.length - a.length)
			.map((v) => v.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(/\s+/g, String.raw`\s+`))

		const alts = variants.join("|")

		// The identifier must contain a digit.
		// It is optional unless the type requires a number.
		const tail = requiresNumber
			? String.raw`\s+([A-Za-z]?\d[\dA-Za-z-]*|\d[\dA-Za-z-]*)`
			: String.raw`(?:\s+([A-Za-z]?\d[\dA-Za-z-]*|\d[\dA-Za-z-]*))?`

		rows.push({ code, requiresNumber, re: new RegExp(String.raw`^\s*(${alts})${tail}\s*$`, "i") })
	}

	return rows
})()

/**
 * Parses a standalone Australian level designator, such as "Level 3", "Ground Floor" or "B 2".
 *
 * Returns null for any other input, including a type that requires a number
 * but has none, such as a bare "Level".
 */
export function matchAuLevelDesignator(input: unknown): AuLevelDesignatorMatch | null {
	if (typeof input !== "string") return null

	for (const { code, re } of LEVEL_MATCHERS) {
		const m = re.exec(input)

		if (!m) continue

		return {
			matched: m[1]!.trim(),
			code,
			...(m[2] ? { identifier: m[2] } : {}),
		}
	}

	return null
}

/**
 * Returns whether the input is a standalone Australian level designator.
 */
export function isAuLevelDesignator(input: unknown): boolean {
	return matchAuLevelDesignator(input) !== null
}

/**
 * Normalizes a level designator to its canonical abbreviation, so `"level 3"` becomes `"L 3"`.
 *
 * @returns The input unchanged when it is not a level designator.
 */
export function normalizeAuLevelDesignator(input: string): string {
	const m = matchAuLevelDesignator(input)

	if (!m) return input
	const row = AU_LEVEL_DESIGNATORS.find((r) => r.code === m.code)!

	return m.identifier ? `${row.abbreviation} ${m.identifier.toUpperCase()}` : row.abbreviation
}
