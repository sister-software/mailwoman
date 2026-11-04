// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Splits a unit written at the end of a street, in the words of the row's country, for every source.
 */

import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"
import { designatorTableFor } from "@mailwoman/codex/designator-tables"
import { DESIGNATOR_CLASS, foldDesignatorSpelling } from "@mailwoman/codex/postal/designator"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"
import { resourceDictionaryPath } from "@mailwoman/dictionaries/paths"
import { acceptPostcode } from "@mailwoman/postcode/country-formats"
import type { StreetLocalityEvidence } from "@mailwoman/resolver"

import { loadLibpostalDictionary } from "#adapters/libpostal-dictionary"
import { splitStreetLine } from "#adapters/street/line"

/**
 * The words a country writes a unit with, and the street-type words that end its streets.
 */
export interface UnitVocabulary {
	country: string
	/**
	 * Designators written before their identifier (`Bat B`, `STE 302`, `# 190`),
	 * folded by `foldDesignatorSpelling`.
	 */
	prefix: ReadonlySet<string>
	/**
	 * Designators written after their identifier with no space (`2楼`, `305号室`).
	 */
	suffix: ReadonlySet<string>
	/**
	 * Street-type words in the country's official languages, lower-cased (`street`, `rd`, `路`).
	 */
	streetTypes: ReadonlySet<string>
	/**
	 * One-word directionals in the country's official languages, lower-cased (`n`, `sw`, `west`),
	 * which can follow a street's type word or number (`HIGHWAY 6 N`, `CROWN RD SW`).
	 */
	directionals: ReadonlySet<string>
	/**
	 * Where the vocabulary came from: the country's codex designator table,
	 * or libpostal's dictionaries for its official languages.
	 */
	origin: "codex" | "libpostal" | "none"
}

/**
 * A unit split off a street.
 */
export interface TrailingUnitSplit {
	street: string
	unit: string
	/**
	 * Which test confirmed that the remainder is still a street: it ends in a street-type word,
	 * it ends in a number, or the street index holds it.
	 */
	admittedBy: "street-word" | "number" | "attested"
}

/**
 * The context one split reads.
 */
export interface TrailingUnitContext {
	vocabulary: UnitVocabulary
	/**
	 * The street index of the country's premise registers.
	 *
	 * Without it, a remainder is confirmed only by a street-type word or a number.
	 */
	evidence?: StreetLocalityEvidence | null
	locality?: string
	postcode?: string
}

/**
 * The designator classes a unit is written with: a building or staircase, a unit inside it, or a floor.
 *
 * The `block` concept is left out of every country's vocabulary, because a block is a level
 * of the address system that the street line holds (Brazil's `Quadra`, Mexico's `Manzana`),
 * rather than a part of one premise.
 *
 * Number marks are left out: Costa Rica's `#` introduces a street's own number.
 * A country whose `#` is a unit records it as a unit row, as the US table does from Publication 28.
 */
const UNIT_CLASSES = new Set<string>(["premise", "sub_premise", "vertical"])

/**
 * The libpostal dictionaries that list unit words.
 */
const LIBPOSTAL_UNIT_FILES = [
	"unit_types_numbered.txt",
	"level_types_numbered.txt",
	"entrances.txt",
	"staircases.txt",
	"building_types.txt",
] as const

/**
 * A script written without spaces between words.
 *
 * Its unit words follow the number they mark.
 */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * A one-letter abbreviation, such as French `p` for `porte`, which is left out
 * because a street's own initial or a unit's identifier reads the same.
 */
const SINGLE_LETTER = /^\p{L}$/u

/**
 * An identifier after a designator contains a digit or is one letter: `B`, `20C`, `12`.
 */
const UNIT_IDENTIFIER = /^(?:\S*\d\S*|\p{L})$/u

/**
 * The fewest words a street can hold with a unit at its end.
 *
 * They are one street word, the designator and the identifier.
 */
const SHORTEST_STREET_WITH_UNIT = 3

/**
 * The fewest digits an identifier needs before it is compared with the row's postcode.
 *
 * Shorter numbers (`STE 3`) are ordinary unit numbers however the postcode begins.
 */
const SHORTEST_POSTCODE_DIGITS = 4

/**
 * The longest designator matched only in capitals.
 *
 * A two-letter word such as French `ET` (étage) is also running text (`et`, and).
 */
const CAPITALS_ONLY_LENGTH = 2

const VOCABULARY_BY_COUNTRY = new Map<string, Promise<UnitVocabulary>>()

/**
 * The libpostal languages a country writes: its official languages that have a dictionary directory.
 */
async function libpostalLanguages(country: string): Promise<string[]> {
	const official = OFFICIAL_LANGUAGES[country]?.official ?? []
	const languages: string[] = []

	for (const language of official) {
		if (language.length === 2 && (await tryStat(resourceDictionaryPath("libpostal", language, "street_types.txt")))) {
			languages.push(language)
		}
	}

	return languages
}

async function libpostalForms(languages: readonly string[], files: readonly string[]): Promise<Set<string>> {
	const forms = new Set<string>()

	for (const language of languages) {
		for (const file of files) {
			if (!(await tryStat(resourceDictionaryPath("libpostal", language, file)))) continue

			for (const form of await loadLibpostalDictionary(language, file)) {
				forms.add(form)
			}
		}
	}

	return forms
}

async function buildVocabulary(country: string): Promise<UnitVocabulary> {
	const languages = await libpostalLanguages(country)
	const streetTypes = await libpostalForms(languages, ["street_types.txt"])

	const directionals = new Set(
		[...(await libpostalForms(languages, ["directionals.txt"]))].filter((form) => !/\s/u.test(form))
	)

	const prefix = new Set<string>()
	const suffix = new Set<string>()
	const table = designatorTableFor(country)

	if (table) {
		for (const row of table.rows) {
			if (row.partOfStreetLine || row.concept === "block" || !UNIT_CLASSES.has(DESIGNATOR_CLASS[row.concept])) {
				continue
			}

			const target = row.position === "prefix" ? prefix : row.position === "suffix" ? suffix : null

			for (const spelling of [row.spelling, ...row.abbreviations]) {
				const folded = foldDesignatorSpelling(spelling)

				if (!SINGLE_LETTER.test(folded) || UNSPACED_SCRIPT.test(folded)) {
					target?.add(folded)
				}
			}
		}

		return { country, prefix, suffix, streetTypes, directionals, origin: "codex" }
	}

	// libpostal lists some unit words among the street-line words too
	// (English `block` and `lot` are street types, Spanish `manzana` and `conjunto` qualifiers),
	// which marks them as words a street line holds.
	const streetLineWords = new Set(
		[...(await libpostalForms(languages, ["street_types.txt", "qualifiers.txt"]))].map(foldDesignatorSpelling)
	)

	for (const form of await libpostalForms(languages, LIBPOSTAL_UNIT_FILES)) {
		const folded = foldDesignatorSpelling(form)

		if (streetLineWords.has(folded)) continue

		if (UNSPACED_SCRIPT.test(folded)) {
			suffix.add(folded)
		} else if (!SINGLE_LETTER.test(folded)) {
			prefix.add(folded)
		}
	}

	return {
		country,
		prefix,
		suffix,
		streetTypes,
		directionals,
		origin: prefix.size + suffix.size > 0 ? "libpostal" : "none",
	}
}

/**
 * The unit vocabulary for `country`, read once per process.
 *
 * The country's codex designator table supplies it where one exists.
 * Every other country reads libpostal's unit, floor, entrance, staircase
 * and building words for its official languages (`OFFICIAL_LANGUAGES`),
 * so every country gets the same treatment from the same rule.
 *
 * A designator row marked `partOfStreetLine` is left out, so the splitter keeps it in the street.
 */
export function unitVocabularyFor(country: string): Promise<UnitVocabulary> {
	const code = country.toUpperCase()
	let vocabulary = VOCABULARY_BY_COUNTRY.get(code)

	if (!vocabulary) {
		vocabulary = buildVocabulary(code)
		VOCABULARY_BY_COUNTRY.set(code, vocabulary)
	}

	return vocabulary
}

/**
 * Splits the last unit off `street`, or returns `null`.
 */
function splitLastUnit(
	street: string,
	vocabulary: UnitVocabulary,
	postcode: string | undefined
): { street: string; unit: string } | null {
	const tokens = street.trim().split(/\s+/u)
	const last = tokens.at(-1) ?? ""
	const postcodeDigits = postcode?.replaceAll(/\D/gu, "") ?? ""

	// An identifier that repeats the row's own postcode is a city, region and postcode
	// tail run into the street (`TAMPA ROAD PALM HARBOR FL 34683`).
	// A one-letter directional after a designator that is also a street type
	// belongs to the street: libpostal lists `front` among English street types,
	// so `Ocean Front S` is a street and `Suite C` a unit.
	const identifierAt = (token: string, designator?: string) => {
		const identifier = token.replace(/^#/u, "")

		if (!UNIT_IDENTIFIER.test(identifier)) return false

		if (
			SINGLE_LETTER.test(identifier) &&
			vocabulary.directionals.has(identifier.toLowerCase()) &&
			designator != null &&
			vocabulary.streetTypes.has(designator.replace(/[.,]$/u, "").toLowerCase())
		) {
			return false
		}

		const digits = identifier.replaceAll(/\D/gu, "")

		return !(digits.length >= SHORTEST_POSTCODE_DIGITS && postcodeDigits.startsWith(digits))
	}

	const designatorAt = (token: string) => {
		const folded = foldDesignatorSpelling(token.replace(/[.,]$/u, ""))

		if (!vocabulary.prefix.has(folded)) return false

		return token.replace(/[.,]$/u, "").length > CAPITALS_ONLY_LENGTH || token === token.toUpperCase()
	}

	const at = (start: number) => ({
		street: tokens
			.slice(0, start)
			.join(" ")
			.replace(/[\s,–-]+$/u, ""),
		unit: tokens.slice(start).join(" "),
	})

	// `2楼`: an identifier and a suffix designator at the end of an unspaced street.
	for (const designator of vocabulary.suffix) {
		const match = new RegExp(`^(.*\\S)(\\d+[A-Za-z]?${escapeRegExp(designator)})$`, "u").exec(last)

		if (match) {
			const remainder = [...tokens.slice(0, -1), match[1]!].join(" ")

			return { street: remainder, unit: match[2]! }
		}
	}

	// `SUITE # 200`: a designator, a number sign apart from the identifier, then the identifier.
	if (
		tokens.length >= SHORTEST_STREET_WITH_UNIT + 1 &&
		tokens.at(-2) === "#" &&
		designatorAt(tokens.at(-3)!) &&
		identifierAt(last)
	) {
		return at(tokens.length - 3)
	}

	// `Bat B`, `STE 300`, `# 190`: a designator, then the identifier.
	if (tokens.length >= SHORTEST_STREET_WITH_UNIT && designatorAt(tokens.at(-2)!) && identifierAt(last, tokens.at(-2))) {
		return at(tokens.length - 2)
	}

	if (tokens.length < 2) return null

	// `#120`: a number sign joined to its identifier, where the country writes `#` as a unit.
	if (vocabulary.prefix.has("#") && /^#\S/u.test(last) && identifierAt(last)) {
		return at(tokens.length - 1)
	}

	// `RM203`: a designator joined to a numeric identifier.
	// A joined identifier that is a whole postcode of the country is a region and postcode run
	// together (`BAY FL33157`), which is not a unit, even where the row records no postcode.
	const joined = /^(\p{L}{2,})(\d\S*)$/u.exec(last)

	if (
		joined &&
		designatorAt(joined[1]!) &&
		identifierAt(joined[2]!) &&
		!acceptPostcode(joined[2]!, vocabulary.country)
	) {
		return at(tokens.length - 1)
	}

	return null
}

/**
 * Whether `remainder` still reads as a street, and by which test.
 */
function streetEvidence(remainder: string, context: TrailingUnitContext): TrailingUnitSplit["admittedBy"] | null {
	const words = remainder.split(/\s+/u).map((word) => word.replace(/[.,]$/u, "").toLowerCase())

	// A directional after the street's type word or number (`HIGHWAY 6 N`, `IH 10 West`) is stepped over.
	while (words.length > 1 && context.vocabulary.directionals.has(words.at(-1)!)) {
		words.pop()
	}

	const last = words.at(-1)!

	if (context.vocabulary.streetTypes.has(last)) return "street-word"

	for (const type of context.vocabulary.streetTypes) {
		if (UNSPACED_SCRIPT.test(type) && last.endsWith(type)) return "street-word"
	}

	if (/\d/u.test(last)) return "number"

	const scope = {
		...(context.locality ? { locality: context.locality } : {}),
		...(context.postcode ? { postcode: context.postcode } : {}),
	}

	if (!context.evidence?.countries.has(context.vocabulary.country)) return null

	// A whole street line still holds its house number (`12 BD SAINT-JACQUES`).
	// The index's street names hold none, so the probe also tries the line without it.
	const withoutNumber = splitStreetLine(remainder)?.street ?? remainder

	for (const street of new Set([remainder, withoutNumber])) {
		if (context.evidence.hasStreetName(street, scope)) return "attested"
	}

	return null
}

/**
 * The place a street line belongs to.
 *
 * Its locality and postcode scope a street-index probe.
 */
export interface StreetPlace {
	country: string
	locality?: string
	postcode?: string
}

/**
 * Splits units off street lines for every country, synchronously, after
 * {@linkcode createUnitSplitter} has read each country's vocabulary.
 */
export interface UnitSplitter {
	split(street: string, place: StreetPlace): TrailingUnitSplit | null
}

export interface CreateUnitSplitterOptions {
	/**
	 * The street index for the premise registers, built by `#tools/street-index/build`.
	 *
	 * Without it, a remainder is confirmed only by a street-type word or a number.
	 */
	streetIndex?: StreetIndexOpener | null
}

/**
 * Opens the street index for one country, or returns `null` where it holds none.
 */
export type StreetIndexOpener = (country: string) => StreetLocalityEvidence | null

/**
 * A splitter over every country codex or `OFFICIAL_LANGUAGES` lists.
 */
export async function createUnitSplitter(options: CreateUnitSplitterOptions = {}): Promise<UnitSplitter> {
	const countries = Object.keys(OFFICIAL_LANGUAGES)

	const vocabularies = new Map(
		await Promise.all(countries.map(async (country) => [country, await unitVocabularyFor(country)] as const))
	)

	const evidence = new Map<string, StreetLocalityEvidence | null>()

	return {
		split(street, place) {
			const country = place.country.toUpperCase()
			const vocabulary = vocabularies.get(country)

			if (!vocabulary || vocabulary.origin === "none") return null

			if (!evidence.has(country)) {
				evidence.set(country, options.streetIndex?.(country) ?? null)
			}

			return splitTrailingUnit(street, {
				vocabulary,
				evidence: evidence.get(country) ?? null,
				...(place.locality ? { locality: place.locality } : {}),
				...(place.postcode ? { postcode: place.postcode } : {}),
			})
		},
	}
}

/**
 * Splits a unit off the end of `street` when two tests hold.
 *
 * The street's last words are a unit designator from the row's country's vocabulary and an identifier
 * (`du General Charles de Gaulle Bat B`, `LAWRENCE EXPY # 190`, `MAIN ST. RM203`, `武定路1101弄2楼`).
 * What remains still reads as a street: it ends in a street-type word or a number,
 * or the street index of the country's premise registers holds it.
 *
 * `Chemin de la Tour D` therefore keeps its `Tour D`: `Chemin de la` ends in neither,
 * and no register publishes it.
 *
 * A designator that opens the street (`PIER 39`, `Tour Eiffel`) keeps it.
 * A line ending in two units (`ROSS AVE. BLDG2 SUITE207B`) yields both as one unit, in the order written.
 *
 * @returns `null` when the street ends in no unit the tests confirm.
 */
export function splitTrailingUnit(street: string, context: TrailingUnitContext): TrailingUnitSplit | null {
	const last = splitLastUnit(street, context.vocabulary, context.postcode)

	if (!last) return null
	const earlier = splitTrailingUnit(last.street, context)

	if (earlier) return { ...earlier, unit: `${earlier.unit} ${last.unit}` }
	const admittedBy = streetEvidence(last.street, context)

	return admittedBy ? { street: last.street, unit: last.unit, admittedBy } : null
}
