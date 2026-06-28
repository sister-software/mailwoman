/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Canadian street types and directionals — BILINGUAL, because Canada Post recognizes both English
 *   and French forms on the same national network.
 *
 *   The informative contrast with `us/street-suffix.ts`, `de/street-type.ts`, and `fr/voie.ts`:
 *
 *   - US — a trailing word with a USPS-standardized abbreviation (`Main Street` → `ST`).
 *   - German — a fused TRAILING suffix (`Hauptstraße`).
 *   - French — a LEADING standalone word (`Rue de la Paix`).
 *   - Canadian — BOTH at once. An English street puts the type LAST (`Maple Avenue`, `Sunset
 *       Crescent`); a French street puts it FIRST (`Rue Sainte-Catherine`, `Boulevard
 *       René-Lévesque`). So {@link isCanadianStreetWord} matches a whole token against EITHER
 *       vocabulary and stays position-agnostic — it cannot assume a side the way the
 *       single-language files do.
 *
 *   The directionals carry the same bilingual twist, and one trap inside it: French `Ouest`
 *   abbreviates to `O`, not `W`. A naive English-only matcher reading `Rue Sherbrooke O` would miss
 *   the quadrant entirely. {@link CA_DIRECTIONALS} spells out the French abbreviations so `O` =
 *   Ouest = West is recognized.
 */

/**
 * English Canadian street-type words (Canada Post's recognized set, lowercase). Appear as the TRAILING token of an
 * English street name (`Maple Avenue`, `Sunset Crescent`).
 */
export const CA_STREET_TYPES_EN: ReadonlySet<string> = new Set([
	"street",
	"avenue",
	"boulevard",
	"drive",
	"road",
	"crescent",
	"court",
	"place",
	"lane",
	"way",
	"trail",
	"terrace",
	"close",
	"circle",
	"square",
	"heights",
	"grove",
	"gardens",
	"hill",
	"park",
	"row",
	"walk",
	"green",
	"bay",
	"cove",
	"gate",
	"point",
	"ridge",
	"view",
])

/**
 * French Canadian street-type words (Canada Post's recognized set, lowercase, accent-bearing). Appear as the LEADING
 * token of a French street name (`Rue Sainte-Catherine`, `Chemin du Roy`). Folded for matching in
 * {@link isCanadianStreetWord}, so `Côte`/`cote` and `Allée`/`allee` key alike.
 */
export const CA_STREET_TYPES_FR: ReadonlySet<string> = new Set([
	"rue",
	"avenue",
	"boulevard",
	"chemin",
	"côte",
	"place",
	"impasse",
	"allée",
	"croissant",
	"montée",
	"rang",
	"ruelle",
	"voie",
	"passage",
	"carré",
	"terrasse",
	"promenade",
	"sentier",
])

/** Strip diacritics + lowercase so `Côte`/`cote`, `Allée`/`allee`, `Crescent`/`crescent` key alike. */
function foldToken(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z]/g, "")
}

/** The English + French street-type vocabularies, both folded, for one position-agnostic lookup. */
const STREET_WORD_SET: ReadonlySet<string> = (() => {
	const out = new Set<string>()

	for (const w of CA_STREET_TYPES_EN) out.add(foldToken(w))

	for (const w of CA_STREET_TYPES_FR) out.add(foldToken(w))

	return out
})()

/**
 * True when a token is a Canadian street-type word in EITHER language (case- and accent-insensitive) — `Street`,
 * `Crescent`, `Rue`, `Chemin`, `Côte`. Position-agnostic, because an English type trails the name and a French type
 * leads it; the matcher cannot lean on a side.
 */
export function isCanadianStreetWord(token: unknown): boolean {
	if (typeof token !== "string") return false
	const t = foldToken(token)

	return t.length > 0 && STREET_WORD_SET.has(t)
}

/**
 * Bilingual directional words → canonical compass letter. Covers the bare letters (`N S E W`), the full English words
 * (`North`/`South`/`East`/`West`), and the full French words (`Nord`/`Sud`/`Est`/`Ouest`). The bilingual twist is `O`:
 * French `Ouest` abbreviates to `O`, NOT `W`, so an English-only matcher silently drops the quadrant on a French
 * address line. Keys are folded (lowercase, accent-free); values are the English compass letter.
 */
export const CA_DIRECTIONALS: Record<string, "N" | "S" | "E" | "W"> = {
	n: "N",
	north: "N",
	nord: "N",
	s: "S",
	south: "S",
	sud: "S",
	e: "E",
	east: "E",
	est: "E",
	w: "W",
	west: "W",
	ouest: "W",
	o: "W", // French Ouest abbreviates to O, not W — the bilingual trap.
}

/**
 * True when a token is a Canadian directional in either language (case- and accent-insensitive) — `N`, `NW`, `Nord`,
 * `Ouest`, `O`. Compound English quadrants (`NW`, `SE`) are accepted by decomposing into their single-letter halves;
 * the lone French `O` resolves to West.
 */
export function isCanadianDirectional(token: unknown): boolean {
	if (typeof token !== "string") return false
	const t = foldToken(token)

	if (t.length === 0) return false

	if (t in CA_DIRECTIONALS) return true

	// Compound English quadrants like NW / SE / NE / SW: each half must be a single-letter directional.
	if (t.length === 2) {
		const isLetter = (h: string): boolean => h === "n" || h === "s" || h === "e" || h === "w"

		return isLetter(t[0]!) && isLetter(t[1]!)
	}

	return false
}
