/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS Publication 28 — Military / Diplomatic Post Office designators.
 *
 *   Military and diplomatic overseas addresses use a distinct addressing scheme: instead of a city
 *   name, a standardized location-class code (APO, FPO, DPO) appears on the city line, followed by
 *   the armed-forces "state" code (AA, AE, AP) and a 09xxx ZIP code. The unit/PSC/CMR line
 *   appearing above the city line identifies the specific installation unit, postal service center,
 *   or community mail room.
 *
 *   Sourcing (accessed 2026-06-12):
 *
 *   - **USPS Publication 28, Chapter 7** ("Armed Forces and Diplomatic Post Offices") defines the three
 *       armed-forces location codes and three state-code regions, and states: "Use APO with AA
 *       (Americas), AE (Europe/Middle East/Africa/Canada), or AP (Pacific)"; "FPO (Fleet Post
 *       Office) for Navy ships and shore installations"; "DPO (Diplomatic Post Office) for US
 *       embassies and missions." Full URL: https://pe.usps.com/text/pub28/28c7_001.htm
 *   - **USPS Publication 28, Appendix B** gives the complete list of accepted unit-line formats: `UNIT
 *       <id>`, `PSC <id> BOX <box>`, `CMR <id> BOX <box>`, and `UNIT <id> BOX <box>`. The same
 *       appendix notes the two-digit unit ranges for PSC/CMR/UNIT assignment by theater. Full URL:
 *       https://pe.usps.com/text/pub28/28apb_001.htm
 *   - The **Armed Forces "state" codes** (AA, AE, AP) are defined in the same USPS appendix and are
 *       also the official USPS abbreviations for the three Armed Forces addressing regions. See:
 *       https://pe.usps.com/text/pub28/28apb_002.htm
 *   - "DPO" for Diplomatic Post Offices was added as a distinct code in 2011 (USPS Customer/ Industry
 *       Notice 61). It does NOT replace APO in diplomatic mail — both exist, with DPO used
 *       specifically for State Department overseas posts and APO/FPO retained for DoD.
 *
 * @see {@link https://pe.usps.com/text/pub28/28c7_001.htm USPS Pub 28 Chapter 7 — Military Addresses}
 * @see {@link https://pe.usps.com/text/pub28/28apb_001.htm USPS Pub 28 Appendix B — Armed Forces Addresses}
 */

/** USPS military / diplomatic post-office location codes (the "city" substitute on the city line). */
export const US_MILITARY_POST_OFFICE_CODES = [
	/**
	 * Army Post Office — domestic USPS gateway for Army and Air Force overseas mail; also used for some diplomatic
	 * addresses (DPO is preferred for State Dept posts since 2011).
	 */
	{ code: "APO", name: "Army Post Office", armedForces: true },
	/** Fleet Post Office — Navy ships and shore installations. */
	{ code: "FPO", name: "Fleet Post Office", armedForces: true },
	/** Diplomatic Post Office — US embassies and missions (added 2011). */
	{ code: "DPO", name: "Diplomatic Post Office", armedForces: false },
] as const

export type UsMilitaryPostOfficeCode = (typeof US_MILITARY_POST_OFFICE_CODES)[number]["code"]

/**
 * USPS Armed Forces "state" codes used in place of state names on military/diplomatic addresses. These appear where a
 * US state abbreviation (NY, CA, …) would appear in a civilian address.
 */
export const US_ARMED_FORCES_REGIONS = [
	{ code: "AA", name: "Armed Forces Americas", description: "Americas (excluding Canada)" },
	{ code: "AE", name: "Armed Forces Europe", description: "Europe, Middle East, Africa, and Canada" },
	{ code: "AP", name: "Armed Forces Pacific", description: "Pacific" },
] as const

export type UsArmedForcesRegionCode = (typeof US_ARMED_FORCES_REGIONS)[number]["code"]

/**
 * USPS Pub 28 Appendix B unit-line designators for military/diplomatic overseas addresses. Each designator introduces
 * an installation identifier and optionally a box number.
 *
 * Format rules per Appendix B:
 *
 * - `PSC <id> BOX <box>` — Postal Service Center
 * - `CMR <id> BOX <box>` — Community Mail Room
 * - `UNIT <id> BOX <box>` — numbered unit (battalion/company); UNIT may stand alone with just an id and no BOX when the
 *   unit has direct mail delivery
 *
 * BOX is required for PSC and CMR; UNIT may omit BOX.
 */
export const US_MILITARY_UNIT_DESIGNATORS = [
	{
		code: "PSC",
		name: "Postal Service Center",
		requiresBox: true,
		description: "Installation-level postal service center; format: PSC <id> BOX <box>",
	},
	{
		code: "CMR",
		name: "Community Mail Room",
		requiresBox: true,
		description: "Sub-installation mail room; format: CMR <id> BOX <box>",
	},
	{
		code: "UNIT",
		name: "Unit",
		requiresBox: false,
		description: "Numbered military unit (battalion/company); format: UNIT <id> [BOX <box>]",
	},
] as const

export type UsMilitaryUnitDesignatorCode = (typeof US_MILITARY_UNIT_DESIGNATORS)[number]["code"]

/** Result of a military address line parse (the unit line: PSC/CMR/UNIT). */
export interface UsMilitaryUnitMatch {
	/** The designator as it appeared ("PSC", "CMR", "Unit"). */
	matched: string
	/** The canonical designator code ("PSC", "CMR", "UNIT"). */
	code: UsMilitaryUnitDesignatorCode
	/** The installation identifier ("1520", "453"). */
	id: string
	/** The box number when present ("4620", "1234A"). */
	box?: string
}

// Unit-line regex: PSC/CMR/UNIT <id> [BOX <box>]
// Identifiers are numeric; box numbers are alphanumeric. UNIT may stand without BOX.
const UNIT_LINE_RE = /^\s*(psc|cmr|unit)\s+(\d+)(?:\s+box\s+([\dA-Za-z]+))?\s*$/i

/**
 * If `input` is a USPS military unit-line ("PSC 1520 BOX 4620", "CMR 453 BOX 100", "UNIT 7 BOX 234A", "UNIT 7"), return
 * the canonical designator, installation id, and optional box. Null otherwise. Throws on a PSC or CMR line without a
 * BOX component (per Appendix B, BOX is required for PSC/CMR; a bare "PSC 1520" is malformed).
 */
export function matchMilitaryUnitLine(input: unknown): UsMilitaryUnitMatch | null {
	if (typeof input !== "string") return null
	const m = UNIT_LINE_RE.exec(input)

	if (!m) return null
	const code = m[1]!.toUpperCase() as UsMilitaryUnitDesignatorCode
	const id = m[2]!
	const box = m[3]

	const row = US_MILITARY_UNIT_DESIGNATORS.find((r) => r.code === code)!

	if (row.requiresBox && !box) {
		throw new Error(
			`[codex/us/military-address] ${code} line requires a BOX component per USPS Pub 28 Appendix B; got bare "${input.trim()}"`
		)
	}

	return { matched: m[1]!, code, id, ...(box ? { box } : {}) }
}

/** Type-predicate: does the input look like a USPS military unit line (PSC/CMR/UNIT)? */
export function isMilitaryUnitLine(input: unknown): boolean {
	try {
		return matchMilitaryUnitLine(input) !== null
	} catch {
		return false // PSC/CMR without BOX is structurally malformed (not a false negative)
	}
}

/** Result of a military city-line parse (APO/FPO/DPO + region code + ZIP). */
export interface UsMilitaryCityMatch {
	/** The post-office code as it appeared ("APO", "FPO", "DPO"). */
	matched: string
	/** The canonical post-office code. */
	code: UsMilitaryPostOfficeCode
	/** The Armed Forces region code ("AA", "AE", "AP"). */
	region: UsArmedForcesRegionCode
	/**
	 * The 5-digit or 9-digit ZIP code. Typical ranges per Pub 28: 09xxx (AE), 34xxx (AA), 96xxx (AP) — range validation
	 * per region is caller responsibility.
	 */
	zip: string
}

// City-line regex: APO/FPO/DPO <region> <zip>
// USPS military ZIP assignment per Pub 28 and the Armed Forces zip code list:
//   - AA (Americas): 340xx range
//   - AE (Europe/ME/Africa/Canada): 09xxx range
//   - AP (Pacific): 962xx-966xx range
// The regex accepts any 5-digit or 9-digit ZIP code in combination with a valid region code —
// validating the specific numeric range for each region is left to the caller (region+ZIP
// co-validation is operational policy, not structural syntax).
const CITY_LINE_RE = /^\s*(apo|fpo|dpo)\s+(aa|ae|ap)\s+(\d{5}(?:-\d{4})?)\s*$/i

/**
 * If `input` is a USPS military city line ("APO AE 09165", "FPO AP 96602-1254", "DPO AE 09498", "APO AA 34022", "APO AP
 * 96525"), return the canonical code, region, and ZIP. Null otherwise.
 *
 * ZIP ranges per Pub 28: AE (Europe/ME/Africa/Canada) → 09xxx; AP (Pacific) → 96xxx; AA (Americas) → 34xxx. Range
 * validation per region is left to the caller; the matcher accepts any 5. or 9-digit ZIP paired with a valid region
 * code.
 */
export function matchMilitaryCityLine(input: unknown): UsMilitaryCityMatch | null {
	if (typeof input !== "string") return null
	const m = CITY_LINE_RE.exec(input)

	if (!m) return null

	return {
		matched: m[1]!.toUpperCase(),
		code: m[1]!.toUpperCase() as UsMilitaryPostOfficeCode,
		region: m[2]!.toUpperCase() as UsArmedForcesRegionCode,
		zip: m[3]!,
	}
}

/** Type-predicate: does the input look like a USPS military city line (APO/FPO/DPO + region + ZIP)? */
export function isMilitaryCityLine(input: unknown): boolean {
	return matchMilitaryCityLine(input) !== null
}
