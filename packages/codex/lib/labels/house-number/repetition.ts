// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The countries that write a repetition index after a house number, and the words they write.
 *
 *   French addressing numbers a building inserted after number 20 as `20 bis`,
 *   the next as `20 ter`, then `20 quater`.
 *   The index belongs to the house number: the Base Adresse Nationale stores it in its
 *   `rep` column beside `numero`, and the BAN adapter joins the two as `20 bis`.
 *
 *   A publisher that writes the whole street line in one field, `20 BIS RUE LOUIS PHILIPPE`,
 *   places the index between the number and the street name, where a number-first
 *   split would otherwise read it as the street's first word.
 *
 *   The same words are street-name words elsewhere: Dutch and Flemish `Ter Haarstraat`
 *   and `Ter Waarde`, Spanish `Calle Ter`, Irish `Decies Road`.
 *   The words are therefore read only in the countries listed here.
 */

/**
 * The repetition indexes, lower-cased, in the order a street numbers them.
 *
 * These are the values BAN's `rep` column holds as words.
 * Its single-letter values (`a`, `b`) are a different suffix and aren't listed.
 */
export const HOUSE_NUMBER_REPETITION_INDEXES: readonly string[] = ["bis", "ter", "quater"]

/**
 * The countries a published source shows writing a repetition index
 * after the house number, each with its source.
 */
export const CITED_REPETITION_INDEX_COUNTRIES: Readonly<Record<string, string>> = {
	// The Base Adresse Nationale covers metropolitan France and the INSEE-coded overseas
	// jurisdictions that publish rows, and stores the index in its `rep` column for each of them.
	FR: "Base Adresse Nationale `rep` column",
	BL: "Base Adresse Nationale `rep` column (INSEE department 977)",
	GF: "Base Adresse Nationale `rep` column (INSEE department 973)",
	GP: "Base Adresse Nationale `rep` column (INSEE department 971)",
	MF: "Base Adresse Nationale `rep` column (INSEE department 978)",
	MQ: "Base Adresse Nationale `rep` column (INSEE department 972)",
	NC: "Base Adresse Nationale `rep` column (INSEE department 988)",
	PF: "Base Adresse Nationale `rep` column (INSEE department 987)",
	PM: "Base Adresse Nationale `rep` column (INSEE department 975)",
	RE: "Base Adresse Nationale `rep` column (INSEE department 974)",
	YT: "Base Adresse Nationale `rep` column (INSEE department 976)",
	// GLEIF golden copy, registered addresses: `49 BIS AVENUE DE L'ANNONCIADE, MC-98000 MONACO`.
	MC: "GLEIF LEI golden copy registered addresses",
	// GLEIF golden copy: `29, BIS MERE BARTHELEMY STREET, PORT LOUIS`.
	MU: "GLEIF LEI golden copy registered addresses",
	// GLEIF golden copy: `10 Bis Rue Mahmoud El Matri, 1002 Tunis`.
	TN: "GLEIF LEI golden copy registered addresses",
	// GLEIF golden copy: `25 BIS NGUYEN THI MINH KHAI STREET, HO CHI MINH CITY`.
	VN: "GLEIF LEI golden copy registered addresses",
}

/**
 * The repetition indexes a country writes after a house number, or an empty
 * list for a country that writes none.
 */
export function houseNumberRepetitionIndexes(country: string): readonly string[] {
	return Object.hasOwn(CITED_REPETITION_INDEX_COUNTRIES, country.toUpperCase()) ? HOUSE_NUMBER_REPETITION_INDEXES : []
}
