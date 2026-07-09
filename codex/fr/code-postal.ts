/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   French postal codes (code postal): the branded type, the shape, normalization, and the
 *   first-two-digits → département mapping — the cleanest postcode→admin prior of the three
 *   systems.
 *
 *   The informative contrast across `us/zipcode.ts`, `de/postleitzahl.ts`, and here:
 *
 *   - A US ZIP's first digit maps to a loose BAND of states.
 *   - A German PLZ's first digit maps to a Leitzone that CROSSES Bundesland borders.
 *   - A French code postal's first TWO digits ARE the département number directly (`75008` → 75, Paris;
 *       `13001` → 13, Bouches-du-Rhône). So the French prefix pins the actual admin unit, and the
 *       région follows from the département. It is the tightest of the three.
 *
 *   The exceptions are the interesting part: Corsica shares prefix `20` across two départements (`2A`
 *   Corse-du-Sud / `2B` Haute-Corse, resolved by the rest of the code), and the overseas DOM use a
 *   THREE-digit prefix (`971`–`976`). `departementOfCodePostal` handles both. Two further
 *   real-world caveats it does NOT try to model: a handful of communes sit under a neighbouring
 *   département's code (e.g. some `05`/`04` border villages), and a CEDEX code can carry a
 *   large-volume-mail prefix that differs from the geographic one — both rare enough to leave to
 *   the gazetteer.
 */

import type { Tagged } from "type-fest"

import { departementInfo, type DepartementCode, type DepartementInfo } from "./departement.ts"
import { FR_REGIONS, type FrenchRegionInfo } from "./region.ts"

/**
 * A French postal code: five digits (`75008`). Same shape as a US ZIP or a German PLZ — the shape alone does not
 * disambiguate the country.
 *
 * @category Postal
 * @type string
 * @title Code postal
 * @pattern ^\d{5}$
 */
export type CodePostal = Tagged<string, "CodePostal">

/** The code-postal shape: exactly five digits. */
export const CODE_POSTAL_PATTERN = /^\d{5}$/

/**
 * Normalize a code-postal surface form to the bare five digits: strip an `F-` country courtesy prefix and surrounding
 * whitespace (`F-75008` → `75008`). Returns null if the result is not five digits.
 */
export function normalizeCodePostal(raw: unknown): CodePostal | null {
	if (typeof raw !== "string") return null
	const s = raw.trim().toUpperCase().replace(/^F-/, "")

	return CODE_POSTAL_PATTERN.test(s) ? (s as CodePostal) : null
}

/** Type-predicate for a (normalized) French postal code. */
export function isCodePostal(input: unknown): input is CodePostal {
	return typeof input === "string" && CODE_POSTAL_PATTERN.test(input)
}

/**
 * The département code a postal code belongs to. The clean rule plus its two exceptions:
 *
 * - `20xxx` → Corsica. The split is by the rest of the code: roughly `20000`–`20199` → `2A` (Ajaccio side), `20200`+ →
 *   `2B` (Bastia side). Approximate at the boundary, exact for the bulk.
 * - `970`–`976`xx → an overseas DOM, keyed by the three-digit prefix (`971`–`974`, `976`).
 * - Otherwise the first two digits are the département number.
 *
 * Returns null for a prefix with no département (e.g. `975`/`977`/`98x` collectivities, or a malformed code).
 */
export function departementOfCodePostal(codePostal: unknown): DepartementCode | null {
	const cp = normalizeCodePostal(codePostal)

	if (!cp) return null

	if (cp.startsWith("20")) {
		// Corsica: prefix 20 covers both départements; the numeric value splits them.
		return Number(cp) < 20200 ? "2A" : "2B"
	}

	if (cp.startsWith("97") || cp.startsWith("98")) {
		// Overseas: three-digit prefix. Only the five DOM are départements.
		const dom = cp.slice(0, 3)

		return departementInfo(dom) ? (dom as DepartementCode) : null
	}
	const dd = cp.slice(0, 2)

	return departementInfo(dd) ? (dd as DepartementCode) : null
}

/** The full département record a postal code resolves to (name + région), or null. */
export function departementForCodePostal(codePostal: unknown): DepartementInfo | null {
	return departementInfo(departementOfCodePostal(codePostal))
}

/**
 * The région a postal code resolves to, via its département; null if the code maps to no département.
 */
export function regionForCodePostal(codePostal: unknown): FrenchRegionInfo | null {
	const dep = departementForCodePostal(codePostal)

	return dep ? FR_REGIONS[dep.region] : null
}
