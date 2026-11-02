/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Splits a premise, sub-premise or floor written at the end of a street, in the words of the row's country.
 */

import { designatorTableFor } from "@mailwoman/codex/designator-tables"
import { DESIGNATOR_CLASS, foldDesignatorSpelling } from "@mailwoman/codex/postal/designator"

/**
 * A street with its trailing unit separated.
 */
export interface StreetAndUnit {
	street: string
	unit: string
}

/**
 * The designator classes a unit is written with: a building, block or staircase
 * (`Bât B`, `Scala C`), a unit inside it (`Appartement 12`) or a floor (`Planta B`).
 *
 * Number marks (`#`, `No`) are left out, because they also introduce a street's own number (`Allée No 3`).
 */
const UNIT_CLASSES = new Set<string>(["premise", "sub_premise", "vertical"])

/**
 * An identifier after a designator contains a digit or is one letter: `B`, `20C`, `12`.
 */
const UNIT_IDENTIFIER = /^(?:\S*\d\S*|\p{L})$/u

/**
 * A short lower-case word, such as an article or preposition (`la`, `des`, `del`), or an elided one (`d’`).
 */
const FUNCTION_WORD = /^\p{Ll}{1,4}$|^\p{Ll}['’]$/u

/**
 * The folded prefix-designator spellings of each country, cached on first use.
 */
const SPELLINGS_BY_COUNTRY = new Map<string, Set<string> | null>()

/**
 * The fewest words a street can hold with a unit at its end.
 *
 * They are one street word, the designator and the identifier.
 */
const SHORTEST_STREET_WITH_UNIT = 3

function prefixSpellings(country: string): Set<string> | null {
	const code = country.toUpperCase()
	const cached = SPELLINGS_BY_COUNTRY.get(code)

	if (cached !== undefined) return cached
	const table = designatorTableFor(code)

	const spellings = table
		? new Set(
				table.rows
					.filter((row) => row.position === "prefix" && UNIT_CLASSES.has(DESIGNATOR_CLASS[row.concept]))
					.flatMap((row) => [row.spelling, ...row.abbreviations])
					.map(foldDesignatorSpelling)
					.filter((spelling) => spelling.length > 0)
			)
		: null

	SPELLINGS_BY_COUNTRY.set(code, spellings)

	return spellings
}

/**
 * Splits a unit off the end of `street` when the street's last two words are a designator
 * from `country`'s codex table and an identifier, as in `du General Charles de Gaulle Bat B`
 * or `VIA REGINA MARGHERITA SCALA C`.
 *
 * The designator must follow at least one street word, so a street that opens
 * with one (`Tour Eiffel`) keeps it.
 * A designator of two letters or fewer matches only in capitals: French `ET` is a floor,
 * and `et` is the conjunction in `Bat E et F`.
 *
 * US register lines go through `splitTrailingUnit` in `#us/street-unit`,
 * which also reads USPS number-sign forms.
 *
 * @returns `null` when the street ends in no unit, or when the codex holds
 * no designator table for `country`.
 */
export function splitCountryTrailingUnit(street: string, country: string): StreetAndUnit | null {
	const spellings = prefixSpellings(country)

	if (!spellings) return null
	const tokens = street.trim().split(/\s+/u)

	if (tokens.length < SHORTEST_STREET_WITH_UNIT) return null
	const identifier = tokens.at(-1)!
	const designator = tokens.at(-2)!.replace(/[.,]$/u, "")

	if (!UNIT_IDENTIFIER.test(identifier)) return null

	if (!spellings.has(foldDesignatorSpelling(designator))) return null

	if (designator.length <= 2 && designator !== designator.toUpperCase()) return null

	// A designator after a lower-case function word belongs to the street's name: `Chemin de la Tour D`.
	if (FUNCTION_WORD.test(tokens.at(-3)!)) return null

	return {
		street: tokens
			.slice(0, -2)
			.join(" ")
			.replace(/[\s,–-]+$/u, ""),
		unit: tokens.slice(-2).join(" "),
	}
}
