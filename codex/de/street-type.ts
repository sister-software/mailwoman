/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   German street types (Straßentypen).
 *
 *   The US analog is `us/street-suffix.ts`, and the structural contrast is the whole lesson of this
 *   file. A US street type is a separate trailing word with a USPS-standardized abbreviation (`Main
 *   Street` → `ST`). A German street type is overwhelmingly an **agglutinative suffix** fused onto
 *   the name (`Straußstraße`, `Karl-Liebknecht-Straße`), with only one abbreviation in real use
 *   (`Str.`). So detection is by suffix, not by a trailing token, and there is no Pub-28-style
 *   abbreviation table to salvage.
 *
 *   The second lesson is the collision, the German cousin of the US `KY` = Key / Kentucky problem.
 *   Many German PLACE names end in what look like street suffixes — `-berg` (Nürnberg), `-burg`
 *   (Hamburg), `-dorf` (Düsseldorf), `-feld`, `-hof`, `-stadt`. If those counted as street markers,
 *   the city token in a `PLZ City` segment would masquerade as a street and wrongly flag the
 *   postcode as a house number. {@link DE_STREET_SUFFIXES} is therefore a curated, place-name-SAFE
 *   set — the suffixes that are distinctively streets and (almost) never the tail of a city name.
 */

/**
 * Canonical German street type → recognized written variants (including the `Str.` abbreviation and
 * the `ß`/`ss` spelling split). The full reference table, used for synthesis/expansion. For the "is
 * this token part of a street" test, use {@link DE_STREET_SUFFIXES} / {@link isGermanStreetToken},
 * which exclude the place-name-colliding suffixes.
 */
export const DE_STREET_TYPE_VARIANTS = {
	Straße: ["Str.", "Str", "Strasse"],
	Weg: [],
	Platz: ["Pl.", "Pl"],
	Gasse: [],
	Allee: [],
	Ring: [],
	Damm: [],
	Ufer: [],
	Steig: [],
	Stieg: [],
	Pfad: [],
	Chaussee: ["Chaussée"],
	Twiete: [],
} as const satisfies Record<string, readonly string[]>

/** A canonical German street type (e.g. `Straße`, `Weg`, `Platz`). */
export type GermanStreetType = keyof typeof DE_STREET_TYPE_VARIANTS

/**
 * Place-name-SAFE street suffixes for "is this token part of a street" detection, lowercase, with
 * the `ß`/`ss` split spelled out and `str` for the `Str.` abbreviation. Deliberately EXCLUDES the
 * suffixes that also end German city names — `-berg`, `-burg`, `-dorf`, `-feld`, `-hof`, `-stadt`,
 * `-heim`, `-bach`, `-tal` — so a city token in a `PLZ City` segment is not mistaken for a street.
 */
export const DE_STREET_SUFFIXES = [
	"straße",
	"strasse",
	"str",
	"weg",
	"platz",
	"gasse",
	"allee",
	"ring",
	"damm",
	"ufer",
	"steig",
	"stieg",
	"pfad",
	"chaussee",
	"twiete",
] as const

/**
 * True when a token reads as (part of) a German street: it ends with one of the place-name-safe
 * {@link DE_STREET_SUFFIXES}. Handles both the fused compound (`Straußstraße` → ends `straße`) and
 * the standalone type word or `Str.` abbreviation (`Platz`, `Str` → end `platz` / `str`).
 */
export function isGermanStreetToken(token: unknown): boolean {
	if (typeof token !== "string") return false
	const t = token.toLowerCase().replace(/[^a-zà-ÿß]/g, "")
	if (t.length < 3) return false
	return DE_STREET_SUFFIXES.some((s) => t.endsWith(s))
}
