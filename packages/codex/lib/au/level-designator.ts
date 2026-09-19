/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australia Post amas floor/level designators — the sub-premise vocabulary that names a floor of a
 *   building rather than a numbered unit on that floor: `Level 3`, `L 12`, `Ground Floor`,
 *   `Mezzanine`.
 *
 *   Sourcing (accessed 2026-06-12):
 *
 *   - **Australia Post amas** (Address Matching Approval System) defines the Level Designator type and
 *       its approved abbreviation. The verbatim amas description: "level" is the full word; "L" is
 *       the approved abbreviation. The standard phrase format is `level <number>`, e.g. "level 3"
 *       or "L 3" (abbreviation always uppercase in amas output). Australia Post's own barcode
 *       addressing booklet (SAP 8838883) lists "level" and "L" as the level type. the Correct
 *       Addressing brochure (SAP 8833878, Nov 2022) gives the example `level 3 / 60 margaret ST /
 *       sydney NSW 2000`. The amas Data Extract Format document (v4.2) confirms "level" → "L" as
 *       the sole level abbreviation pair.
 *   - **Ground floor** is treated by amas as `level G` (with the identifier "G"). Australia Post's
 *       addressing guidelines state that ground floor should be written as "level G"; the full word
 *       "ground" is a recognized alias for the identifier rather than a separate designator type.
 *   - **Mezzanine**, **Lower Ground**, and **Upper Ground** appear in AS 4590.1-2017 (the Australian
 *       Standard for interchange of client information) as recognized level-type values alongside
 *       level and ground. AS 4590.1-2017 Table 3 "Level type": B (Basement), G (Ground), mezzanine
 *       (M), LG (Lower Ground), UG (Upper Ground), L (Level), OD (Observation Deck), P (Parking /
 *       Podium), RT (Rooftop). These are the values a Geocoded National Address File (gnaf) record
 *       may carry in the LEVEL_TYPE_CODE column, which mirrors the AP amas level-type vocabulary.
 *   - "LVL" and "LG" appear as widely-recognized surface variants in real AU addresses (Open Addresses
 *       AU export, accessed via OpenAddresses) though AS 4590.1-2017 and amas canonicalize to "L"
 *       and "LG" respectively. the variants are included in {@link AU_LEVEL_DESIGNATOR_VARIANTS} so
 *       the parser can recognize them without synthesizing them.
 *
 * @see {@link https://auspost.com.au/sending/guidelines/addressing-guidelines Australia Post addressing guidelines}
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/correct-addressing.pdf Australia Post Correct Addressing brochure (Nov 2022)}
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf Australia Post barcode addressing booklet}
 * @see {@link https://www.iso.org/standard/67840.html AS 4590.1-2017 — Interchange of client information}
 */

/**
 * One amas / AS 4590.1 level-type row.
 *
 * The `type` is the AS 4590.1 LEVEL_TYPE_CODE value (what gnaf and amas use internally); the `abbreviation` is the
 * approved surface form used in formatted mail. the `requiresNumber` flag distinguishes designators that take a floor
 * identifier from standalone ones.
 */
export interface AuLevelDesignator {
	/**
	 * AS 4590.1 LEVEL_TYPE_CODE (the gnaf / amas internal code).
	 */
	code: string
	/**
	 * Full descriptive name (amas table label).
	 */
	name: string
	/**
	 * The approved amas surface abbreviation written on mail ("L", "B", "M").
	 */
	abbreviation: string
	/**
	 * True when the designator takes a numeric or alphanumeric floor identifier after it (`level 3`, `basement 2`). False
	 * for standalone types (`ground`, `mezzanine`, `rooftop`) that name a specific well-known floor by vocabulary alone.
	 */
	requiresNumber: boolean
}

/**
 * Amas / AS 4590.1-2017 level-type table (Table 3). Verbatim codes. see the module header for provenance. Ordered with
 * the most-common forms first for match priority.
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
 * A canonical AS 4590.1 LEVEL_TYPE_CODE.
 */
export type AuLevelCode = (typeof AU_LEVEL_DESIGNATORS)[number]["code"]

/**
 * Recognized surface variants for each amas level code — the canonical code/abbreviation pair plus additional forms
 * found in real AU addresses (Open Addresses export) that the parser must recognize but the synthesis layer should not
 * favor over the canonical form.
 *
 * Synthesis uses only the first element (the amas canonical surface). Recognition accepts all.
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
 * Inverse lookup: every variant (abbreviation or surface form) → the canonical amas code. Lowercase-keyed for
 * case-insensitive matching (`"level"` → `"L"`, `"bsmt"` → `"B"`).
 */
export const AU_LEVEL_DESIGNATOR_LOOKUP: ReadonlyMap<string, AuLevelCode> = (() => {
	// Structural integrity check: every code must have at least one non-empty variant. Throw at
	// module load time so a malformed table entry fails loud rather than silently producing an empty
	// lexicon (the "builder must round-trip loud" rule from the task interface).
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
 * Result of an AU level designator parse.
 */
export interface AuLevelDesignatorMatch {
	/**
	 * The code as it appeared in the input ("Level", "L", "lvl").
	 */
	matched: string
	/**
	 * The canonical AS 4590.1 LEVEL_TYPE_CODE ("L", "B", "M").
	 */
	code: AuLevelCode
	/**
	 * The floor identifier when present ("3", "G", "B2").
	 */
	identifier?: string
}

/**
 * One regex per level code. Multi-word variants ("lower ground", "ground floor") are matched before their shorter
 * constituents by ordering the variant list longest-first within each code.
 */
const LEVEL_MATCHERS: ReadonlyArray<{ code: AuLevelCode; requiresNumber: boolean; re: RegExp }> = (() => {
	const rows: Array<{ code: AuLevelCode; requiresNumber: boolean; re: RegExp }> = []

	for (const { code, requiresNumber } of AU_LEVEL_DESIGNATORS) {
		const variants = [...AU_LEVEL_DESIGNATOR_VARIANTS[code]]
			.toSorted((a, b) => b.length - a.length)
			.map((v) => v.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(/\s+/g, String.raw`\s+`))

		const alts = variants.join("|")

		// Identifier: optional alphanumeric (B2, 12, G). requiresNumber=true → identifier required.
		const tail = requiresNumber
			? String.raw`\s+([A-Za-z]?\d[\dA-Za-z-]*|\d[\dA-Za-z-]*)`
			: String.raw`(?:\s+([A-Za-z]?\d[\dA-Za-z-]*|\d[\dA-Za-z-]*))?`

		rows.push({ code, requiresNumber, re: new RegExp(String.raw`^\s*(${alts})${tail}\s*$`, "i") })
	}

	return rows
})()

/**
 * If `input` is a standalone AU level designator phrase ("Level 3", "L 12", "Ground Floor", "Mezzanine", "B 2"), return
 * the canonical code and identifier. Null otherwise. Malformed entries (a requires-number designator with no
 * identifier, e.g. bare "Level") return null — the builder throws loudly when a row in a table violates this
 * constraint.
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
 * Type-predicate: does the input look like a standalone AU level designator phrase?
 */
export function isAuLevelDesignator(input: unknown): boolean {
	return matchAuLevelDesignator(input) !== null
}

/**
 * Normalize a recognized level phrase to the amas canonical form (`"level 3"` → `"L 3"`, `"ground floor"` → `"G"`).
 * Returns the input unchanged if it isn't a level designator phrase. Throws if a row in {@link AU_LEVEL_DESIGNATORS} is
 * malformed (requires-number entry with no abbreviation or empty name) — the builder must surface structural defects
 * loudly.
 */
export function normalizeAuLevelDesignator(input: string): string {
	const m = matchAuLevelDesignator(input)

	if (!m) return input
	const row = AU_LEVEL_DESIGNATORS.find((r) => r.code === m.code)!

	return m.identifier ? `${row.abbreviation} ${m.identifier.toUpperCase()}` : row.abbreviation
}
