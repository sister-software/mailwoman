// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * How the `german` recipe reads a WOF Ortsteil: its German spelling, and whether a tuple's street is one.
 */

import type { CanonicalRow } from "#types"

/**
 * The two ascii spellings WOF uses for one German label, so a `names.deu` row
 * can be matched to the `spr.name` it spells.
 *
 * WOF folds `Bocklemünd` to `Bocklemuend` in one record and `Schöneberg` to `Schoneberg`
 * in another — the transliteration (`ö` → `oe`, `ß` → `ss`) and the plain diacritic strip
 * (`ö` → `o`) both occur — so a match is against either form, lower-cased.
 */
function foldGerman(surface: string): [transliterated: string, stripped: string] {
	const lower = surface.toLowerCase()

	const stripped = lower
		.normalize("NFD")
		.replaceAll(/[\u{300}-\u{36F}]/gu, "")
		.replaceAll("ß", "ss")

	const transliterated = lower
		.replaceAll("ä", "ae")
		.replaceAll("ö", "oe")
		.replaceAll("ü", "ue")
		.replaceAll("ß", "ss")
		.normalize("NFD")
		.replaceAll(/[\u{300}-\u{36F}]/gu, "")

	return [transliterated, stripped]
}

/**
 * Whether two surfaces spell the same German label under either of WOF's folds.
 */
function sameGermanLabel(left: string, right: string): boolean {
	const [leftT, leftS] = foldGerman(left)
	const [rightT, rightS] = foldGerman(right)

	return leftT === rightT || leftS === rightS || leftT === rightS || leftS === rightT
}

/**
 * The surface an Ortsteil is written with in an address, from WOF's rows for it.
 *
 * `spr.name` for a DE neighborhood is the ascii-folded label.
 * The `names` rows in `deu` contain the German spelling beside unrelated labels for co-located
 * features (`Bocklemuend` → `Bocklemünd`, `Jüdischer Friedhof Bocklemünd`, `Menara-Garten`).
 *
 * The German name is the one that spells the same label as `spr.name` under either of
 * WOF's ascii folds ({@link foldGerman}); with none, `spr.name` stands.
 *
 * WOF also prefixes some Ortsteile with their city (`Köln-Nippes`), a form absent from the envelope
 * once the city is its own line, so a leading `<locality>-` is dropped when something is left after it.
 */
export function ortsteilSurface(sprName: string, deuNames: readonly string[], locality: string): string {
	const german = deuNames.find((name) => sameGermanLabel(name, sprName)) ?? sprName
	const prefix = `${locality}-`

	return german.toLowerCase().startsWith(prefix.toLowerCase()) && german.length > prefix.length
		? german.slice(prefix.length)
		: german
}

/**
 * Whether a tuple's street is one of its locality's Ortsteile.
 *
 * An Upper Lusatian hamlet has no streets, and its addresses are `Loga 13, 02699 Neschwitz`.
 */
export function isOrtsteilStreet(street: string, ortsteile: readonly string[] | undefined): boolean {
	return Boolean(ortsteile?.some((ortsteil) => sameGermanLabel(ortsteil, street)))
}

/**
 * The components of a rendered row whose street is an Ortsteil of its locality.
 *
 * With a house number, the hamlet is the street line (`Loga 13`).
 * Without one, it is a place inside the municipality, so it is the `dependent_locality`
 * beside the municipality as `locality` (`Loga, 02699 Neschwitz`).
 */
export function ortsteilStreetComponents(components: CanonicalRow["components"]): CanonicalRow["components"] {
	const { street, ...rest } = components

	if (!street || components.house_number) return components

	return { ...rest, dependent_locality: street }
}
