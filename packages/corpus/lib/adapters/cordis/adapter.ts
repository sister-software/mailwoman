/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `cordis`: the organization files CORDIS publishes for the participants in the EU's research
 * framework programmes, read for the address each participating organization registered.
 *
 * Input is the publisher's own CSV archives, one per programme, as
 * `https://cordis.europa.eu/data/cordis-<programme>projects-csv.zip` serves them for FP7
 * (`fp7`), Horizon 2020 (`h2020`) and Horizon Europe (`HORIZON`).
 * Each archive holds an `organization.csv`: `;`-separated, every field double-quoted, one row per participation.
 * An organizationtherefore appears once for every project it took part in.
 * The adapter streams the member out of the archive through `readZipEntry` and `CSVSpliterator`,
 * so no extracted copy sits on disk.
 * `opts.inputPath` is one archive, one extracted `organization.csv`, or a directory of archives.
 * `fetchCORDIS` writes the directory form.
 *
 * Measured on the archives fetched 2026-10-03, the three members hold 420,811 participation rows and
 * 78,842 distinct published records, and the adapter writes 57,930 rows over 158 countries.
 *
 * ## The columns read
 *
 * `name`, `shortName`, `street`, `postCode`, `city` and `country` reach a row or decide whether
 * one is written. `organisationID`, `activityType`, `SME`, `vatNumber` and `nutsCode` were read while
 * deciding the rules below and reach no row.
 *
 * ## Organizations, and no natural person
 *
 * A corpus holds the addresses of organizations and no address of an identifiable natural person.
 * CORDIS publishes no legal-form column.
 * `activityType` takes the five values `HES`, `PRC`, `REC`, `OTH` and `PUB`, plus an empty value on
 * older rows, and no value marks a natural person.
 * A natural person still enters the participant register: a sole trader, or a researcher contracted
 * in their own name, is registered under their own name, mostly with `activityType` `PRC`.
 * Measured over the three archives, the names of those registrations take three forms, and
 * {@linkcode naturalPersonForm} refuses each:
 *
 * 1. **Every word is a personal name.** `FISK ADRIAN`, `SCHWARZ KAI-UWE WOLFGANG`, `Kerstin
 *    Minnich`: two to four words, each a given name or surname in libpostal's `all` dictionaries,
 *    at least one a given name. 194 records.
 * 2. **The participant register's `SURNAME Given` casing.** `BUCKENHUSKES Herbert Johannes`: an
 *    upper-case run followed by title-case words that are all personal names, one of them a given
 *    name, for a surname the dictionary lacks. 5 records.
 * 3. **A sole-trader legal form.** German `e.K.`, `e.Kfm.` and `e.Kfr.`, and `Inh.` (owner), in the
 *    name or the short name, as in `Melina Bucher e.Kfr.`. 3 records.
 *
 * Neither name rule fires on a name holding a word that is a country's name, so `ERICSSON FRANCE` and
 * `IDEMIA Public Security France` are admitted.
 *
 * The check is a refusal rule rather than a classifier. A sole trader trading under a business name
 * that holds no personal name passes it. Some organizations are refused: `JOHN COCKERILL` by the first
 * rule, and `UAB Nando` and `US Forest Service` among the 5 the casing rule refuses. The count each
 * rule refuses is in the `dropped` map. The natural person a reader would expect first,
 * `CORDOVA Trey Christian`, publishes no street, postcode or city at all and is refused as
 * {@linkcode CORDISRefusal.LocalityAbsent}.
 *
 * The publisher's legal notice states the same limit from its side: reuse may require clearing
 * additional rights "if a specific content depicts identifiable private individuals".
 *
 * ## Country codes
 *
 * CORDIS writes EU country codes, and those differ from ISO 3166-1 in two places: `EL` is Greece and
 * `UK` is the United Kingdom. Both are mapped, to `GR` and `GB`. Any other value that is not an ISO
 * alpha-2 code refuses the row: `XK` (Kosovo, a user-assigned code, 34 records), `ZZ` (1), an empty
 * value (323), and `DE;HU` (1), two countries in one field.
 *
 * A country whose codex `layoutForCountry` is `null` has no rendering to write the row in.
 * The row is refused with {@linkcode CORDISRefusal.CountryNoLayout} rather than rendered in another
 * country's order: 353 records over 37 countries, Ghana's 77 the most.
 *
 * ## The street line
 *
 * `street` holds the whole street line as the participant typed it, usually but not always in the
 * country's own order: `THE WELLCOME TRUST LIMITED` writes `EUSTON ROAD 215 GIBBS BUILDING`, a
 * number-last line in a number-first country. The house number is therefore split off only on the
 * side the country's order puts it, and {@linkcode streetOrderForCountry} reads that side from codex's
 * `house-number-precedes-street` claim. A country whose observations disagree, or state no side,
 * has no unambiguous side, and its lines are kept only where they hold no digit.
 *
 * **A street line holding a digit the split could not place refuses the row**, as `it-anac` does, and
 * so does a line whose remainder still holds a digit once the number is split off. `C GRAN DE GRACIA
 * NUM 1, PLANTA 4, PUERTA 3` would otherwise label `3`, the door, as the house number, and `TRIERSTRAAT
 * 49 STRATENPLAN BUS 7` would label the box. The cost is the street whose name holds a digit, `PLACE DU
 * 20 AOUT 7`, which is refused with the rest. These two rules refuse 14,438 and 4,646 records,
 * the largest share of the 20,911 refused, led by France, Great Britain and Spain.
 *
 * A civic-number marker between the street and the number (`NR`, `NO`, `NUM`, `Nº`) is dropped, so the
 * street is `HAUPTSTRASSE` rather than `HAUPTSTRASSE NR.`. A kilometer point, `CTRA SANT LLORENC DE
 * MORUNYS KM, 2`, is refused rather than read as a house number.
 *
 * ## Placeholders and the postcode
 *
 * A value holding no letter and no digit (`-`, `.`), or one of `N/A`, `NA`, `none`, `Not applicable`,
 * is treated as absent. A postcode with no digit (`EIRE`, `Clare`, `POSTFACH`) and a postcode of
 * zeroes only are dropped from the row rather than refusing it, and counted as `component:postcode:*`.
 * A postcode written with its country prefix, `LV-1063` or `LT-01103`, is kept as published: Latvia
 * and Lithuania write that prefix in their official form.
 *
 * A layout with no slot for a published component leaves it out, and the row is still written:
 * the United Arab Emirates' layout has no locality line, and Japan's Latin layout none below the
 * prefecture. Each is counted as `component:<tag>:unplaced`.
 *
 * ## Deduplication and identity
 *
 * An organizationappears once per project, across three programmes. The adapter reads each distinct
 * published record once, keyed on the five fields that reach a row, and writes each distinct rendered
 * address once. A record whose address changed between programmes contributes one row per version.
 * The row id is content-addressed over the aligned components.
 *
 * ## License
 *
 * The CORDIS legal notice at `https://cordis.europa.eu/about/legal`, read 2026-10-03, states:
 * "Unless otherwise noted (e.g. in individual copyright notices), the reuse of the editorial content on
 * this website owned by the EU is authorized under the Creative Commons Attribution 4.0 International
 * (CC BY 4.0) licence." The same notice records that "The Commission's reuse policy is implemented by
 * Commission Decision 2011/833/EU of 12 December 2011 on the reuse of Commission documents", and the
 * data.europa.eu records for `cordisfp7projects`, `cordish2020projects` and
 * `cordis-eu-research-projects-under-horizon-europe-2021-2027` label each CSV distribution with that
 * decision (`COM_REUSE`). CC BY requires credit and a statement that changes were made, so every row
 * records the license and {@linkcode CORDIS_ATTRIBUTION} is the credit the model card prints.
 *
 * The adapter honors `opts.limit`, `opts.signal` and `opts.country`.
 */

import { ConventionClaimID, ObservationStance } from "@mailwoman/codex/address/convention-claims"
import { formatAddressRow, scriptOfComponents } from "@mailwoman/codex/address/format"
import { conventionClaimForCountry, layoutForCountry } from "@mailwoman/codex/address/layouts"
import { CountryISO2 } from "@mailwoman/codex/country/codes"
import { matchCountry } from "@mailwoman/codex/country/country"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { loadLibpostalDictionary } from "#adapters/libpostal-dictionary"
import { stableSourceID } from "#adapters/source-id"
import { splitStreetLine, splitTrailingStreetLine, type SplitStreetLine } from "#adapters/street-line"
import { SourceRegister } from "#registers"
import {
	AddressRole,
	type AdapterOptions,
	type CanonicalRow,
	type CorpusAdapter,
	countDropped,
	SurfaceOrigin,
} from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const CORDIS_ADAPTER_ID = "cordis"

/**
 * The license the CORDIS legal notice states for content the EU owns.
 */
export const CORDIS_LICENSE = "CC-BY-4.0"

/**
 * The credit CC BY 4.0 obliges.
 *
 * The model card prints it beside the license and a statement that the data was changed.
 */
export const CORDIS_ATTRIBUTION = "© European Union, CORDIS (Publications Office of the European Union)"

/**
 * The archive member that holds the participants in every programme's CSV zip.
 */
export const CORDIS_ORGANIZATION_MEMBER = "organization.csv"

/**
 * The columns the adapter indexes by the publisher's own spelling.
 *
 * Checked against the first record, so a renamed column raises instead of
 * reaching every row as an empty string.
 */
export const CORDIS_REQUIRED_COLUMNS: readonly string[] = [
	"organisationID",
	"name",
	"shortName",
	"activityType",
	"street",
	"postCode",
	"city",
	"country",
]

/**
 * The two places CORDIS's EU country codes differ from ISO 3166-1 alpha-2.
 */
export const CORDIS_COUNTRY_ALIASES: Readonly<Record<string, string>> = {
	EL: "GR",
	UK: "GB",
}

const ISO_ALPHA2: ReadonlySet<string> = new Set(Object.values(CountryISO2))

/**
 * Why a published record did not become a row.
 */
export const CORDISRefusal = {
	/**
	 * `country` is not an ISO 3166-1 alpha-2 code once `EL` and `UK` are mapped.
	 */
	CountryNotISO: "country-not-iso",
	/**
	 * Codex has no layout for the country, so no rendering states where each component goes.
	 */
	CountryNoLayout: "country-no-layout",
	/**
	 * Every word of the name is a personal name.
	 */
	NamePersonalWords: "name-personal-words",
	/**
	 * The name takes the participant register's `SURNAME Given` casing.
	 */
	NamePersonalCasing: "name-personal-casing",
	/**
	 * The name or short name holds a sole-trader legal form.
	 */
	NameSoleTrader: "name-sole-trader",
	/**
	 * The record states no city.
	 */
	LocalityAbsent: "locality-absent",
	/**
	 * The street line holds a digit and no house number could be split off on the country's side.
	 */
	StreetNumberUnplaced: "street-number-unplaced",
	/**
	 * A house number was split off, and the street that remains still holds a digit.
	 */
	StreetDigitInRemainder: "street-digit-in-remainder",
	/**
	 * Beside the locality, the record holds neither a street nor a postcode.
	 */
	ComponentsTooFew: "components-too-few",
	/**
	 * The components do not render in the country's layout.
	 */
	Unrenderable: "unrenderable",
} as const

/**
 * One of the {@link CORDISRefusal} reasons.
 */
export type CORDISRefusal = (typeof CORDISRefusal)[keyof typeof CORDISRefusal]

/**
 * What one published record yielded.
 *
 * `discarded` lists the `component:<tag>:<reason>` keys of values kept out of an admitted row.
 */
export type CORDISReading =
	| { readonly admitted: CanonicalRow; readonly discarded: readonly string[] }
	| { readonly refused: CORDISRefusal; readonly country: string | null }

/**
 * The columns of one `organization.csv` record the adapter reads.
 */
export interface CORDISOrganizationRecord {
	organisationID?: string
	name?: string
	shortName?: string
	activityType?: string
	SME?: string
	vatNumber?: string
	street?: string
	postCode?: string
	city?: string
	country?: string
	nutsCode?: string
}

/**
 * The given names and surnames the personal-name rules consult, lower-cased.
 */
export interface PersonNameLexicon {
	readonly givenNames: ReadonlySet<string>
	readonly surnames: ReadonlySet<string>
}

/**
 * Load libpostal's language-independent given-name and surname dictionaries.
 */
export async function loadPersonNameLexicon(): Promise<PersonNameLexicon> {
	const [givenNames, surnames] = await Promise.all([
		loadLibpostalDictionary("all", "given_names.txt"),
		loadLibpostalDictionary("all", "surnames.txt"),
	])

	return { givenNames, surnames }
}

/**
 * Which side of the street name a country writes the house number on.
 */
export const StreetOrder = {
	NumberFirst: "number-first",
	NumberLast: "number-last",
} as const

/**
 * One of the {@link StreetOrder} values.
 */
export type StreetOrder = (typeof StreetOrder)[keyof typeof StreetOrder]

const streetOrderMemo = new Map<string, StreetOrder | null>()

/**
 * The side a country writes its house number on, or `null` where codex's sources disagree or state none.
 *
 * Read from the `house-number-precedes-street` claim.
 * That claim collects libaddressinput's `fmt` and `lfmt`, the OpenCage street order,
 * the board's hand-authored layout and a retrieved UPU S42 template.
 *
 * A side is returned only when at least one source states it and none states the other.
 *
 * Hong Kong's Chinese-script `fmt` writes the number after the street
 * and its Latin `lfmt` before it, so Hong Kong has no side.
 */
export function streetOrderForCountry(country: string): StreetOrder | null {
	const memo = streetOrderMemo.get(country)

	if (memo !== undefined) return memo

	const claim = conventionClaimForCountry(ConventionClaimID.HouseNumberPrecedesStreet, country)
	const stances = claim?.observations.map((observation) => observation.stance) ?? []
	const supports = stances.includes(ObservationStance.Supports)
	const contradicts = stances.includes(ObservationStance.Contradicts)

	let order: StreetOrder | null = null

	if (supports && !contradicts) {
		order = StreetOrder.NumberFirst
	} else if (contradicts && !supports) {
		order = StreetOrder.NumberLast
	}

	streetOrderMemo.set(country, order)

	return order
}

/**
 * The values the publisher writes where it holds none, compared with whitespace removed and case folded.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(["na", "n/a", "n.a.", "none", "notapplicable", "null", "nil"])

/**
 * Whether a published value is a placeholder for an absent one, or holds no letter and no digit.
 */
export function isCORDISPlaceholder(value: string): boolean {
	const trimmed = value.trim()

	if (!/[\p{L}\d]/u.test(trimmed)) return true

	return PLACEHOLDER_VALUES.has(trimmed.replaceAll(/\s+/gu, "").toLowerCase())
}

/**
 * A published field's value with inner whitespace collapsed, or an empty string
 * where the publisher states none.
 */
function fieldValue(value: string | null | undefined): string {
	const trimmed = (value ?? "").replaceAll(/\s+/gu, " ").trim()

	return isCORDISPlaceholder(trimmed) ? "" : trimmed
}

/**
 * A sole-trader legal form: German `e.K.`, `e.Kfm.`, `e.Kfr.`, or `Inh.` naming the owner.
 *
 * Case-sensitive, because the legal form is written with a lower-case `e`,
 * and `ACADEMICIAN E. K. FIODOROV` holds the same letters as two initials.
 */
const SOLE_TRADER_MARKER = /(?<![\p{L}.])e\.\s?K(?:fm|fr)?\.(?!\p{L})|(?<!\p{L})(?:Inh|INH)\.(?=\s)/u

/**
 * One word of a personal name: letters, with internal hyphens and apostrophes.
 */
const NAME_WORD = /^\p{L}+(?:[-'’]\p{L}+)*$/u

/**
 * A word written in capitals throughout, two letters or more.
 */
const UPPER_WORD = /^\p{Lu}[\p{Lu}'’-]+$/u

/**
 * A word written with one leading capital and lower case after it, two letters or more.
 */
const TITLE_WORD = /^\p{Lu}\p{Ll}+(?:[-'’]\p{Lu}?\p{Ll}+)*$/u

/**
 * The most words a personal name is read with.
 *
 * Four covers a surname with three given names, `SUNDQVIST MARIE CHARLOTTE HELENA`,
 * and keeps the dictionary rule off longer organization names.
 */
const MAX_PERSONAL_NAME_WORDS = 4

/**
 * The shortest word read as a country name.
 *
 * `matchCountry` resolves two- and three-letter codes as well as names, and a two-letter
 * word such as `AS` is a Norwegian legal form rather than a market.
 */
const MIN_COUNTRY_WORD_LENGTH = 4

/**
 * The words a name check reads: two to {@link MAX_PERSONAL_NAME_WORDS},
 * each a {@link NAME_WORD}, or `null` for a name outside that shape.
 */
function nameWords(name: string): string[] | null {
	const words = name.split(/\s+/u).filter((word) => word !== "")

	if (words.length < 2 || words.length > MAX_PERSONAL_NAME_WORDS) return null

	return words.every((word) => NAME_WORD.test(word)) ? words : null
}

/**
 * The personal-name form a participant's name takes, or `null` where it takes none.
 *
 * Exported so a test and a measurement can read the rule the adapter applies rather than a copy of it.
 */
export function naturalPersonForm(name: string, shortName: string, lexicon: PersonNameLexicon): CORDISRefusal | null {
	if (SOLE_TRADER_MARKER.test(name) || SOLE_TRADER_MARKER.test(shortName)) return CORDISRefusal.NameSoleTrader

	const words = nameWords(name.trim())

	if (!words) return null

	const isGiven = (part: string): boolean => lexicon.givenNames.has(part.toLowerCase())
	const isPersonal = (part: string): boolean => isGiven(part) || lexicon.surnames.has(part.toLowerCase())
	// A word naming a country is an organization's market rather than a person's name.
	const namesCountry = (word: string): boolean => word.length >= MIN_COUNTRY_WORD_LENGTH && matchCountry(word) !== null

	if (words.some(namesCountry)) return null

	const parts = words.flatMap((word) => word.split(/-/u))

	if (parts.some(isGiven) && parts.every(isPersonal)) return CORDISRefusal.NamePersonalWords

	// The casing rule reads the upper-case run as a surname the dictionary may lack,
	// so it asks only the title-case words to be personal names, one of them a given name.
	const firstTitle = words.findIndex((word) => !UPPER_WORD.test(word))

	if (firstTitle > 0) {
		const tail = words.slice(firstTitle)
		const tailParts = tail.flatMap((word) => word.split(/-/u))

		if (tail.every((word) => TITLE_WORD.test(word)) && tailParts.some(isGiven) && tailParts.every(isPersonal)) {
			return CORDISRefusal.NamePersonalCasing
		}
	}

	return null
}

/**
 * A civic-number marker left at the end of the street once the number is split off.
 */
const TRAILING_CIVIC_MARKER = /[\s,]+(?:nr|no|n|num|núm|nº|n°)\.?$/iu

/**
 * A kilometer marker followed by its number, as in `CTRA SANT LLORENC DE MORUNYS KM, 2`.
 */
const KILOMETRE_POINT = /(?<!\p{L})km\.?[\s,]*\d/iu

/**
 * A leading number joined to the street by a comma, `12, MG Road`,
 * which {@linkcode splitStreetLine} does not read.
 */
const LEADING_NUMBER_COMMA = /^(\d+[\p{L}]?),\s*/u

/**
 * The street line split on the side the country writes its number, or the refusal the line meets.
 *
 * `order` is `null` for a country with no unambiguous side, and such a line
 * is kept only where it holds no digit.
 */
export function splitCORDISStreetLine(
	line: string,
	order: StreetOrder | null
): SplitStreetLine | { refused: CORDISRefusal } | null {
	const trimmed = line
		.replaceAll(/\s+/gu, " ")
		.replace(/[\s,.;]+$/u, "")
		.trim()

	if (!trimmed) return null

	// A kilometer point identifies a place on a road rather than a premise, so its number is never a house number.
	if (KILOMETRE_POINT.test(trimmed)) return { refused: CORDISRefusal.StreetNumberUnplaced }

	let split: SplitStreetLine | null = { street: trimmed }

	if (order === StreetOrder.NumberFirst) {
		split = splitStreetLine(trimmed.replace(LEADING_NUMBER_COMMA, "$1 "))
	} else if (order === StreetOrder.NumberLast) {
		split = splitTrailingStreetLine(trimmed)
	}

	if (!split) return null

	if (!split.house_number) {
		return /\d/u.test(split.street) ? { refused: CORDISRefusal.StreetNumberUnplaced } : split
	}

	const street = split.street.replace(TRAILING_CIVIC_MARKER, "").trim()

	if (!street || /\d/u.test(street)) return { refused: CORDISRefusal.StreetDigitInRemainder }

	return { house_number: split.house_number, street }
}

/**
 * The ISO 3166-1 alpha-2 code for a CORDIS `country` value, or `null` for one that maps to none.
 */
export function cordisCountryCode(value: string | null | undefined): string | null {
	const code = (value ?? "").trim().toUpperCase()
	const mapped = CORDIS_COUNTRY_ALIASES[code] ?? code

	return ISO_ALPHA2.has(mapped) ? mapped : null
}

/**
 * Read one published record into a row, or report why it yielded none.
 *
 * Exported because the refusal reasons are the measurement this adapter is checked by.
 */
export function readCORDISRecord(record: CORDISOrganizationRecord, lexicon: PersonNameLexicon): CORDISReading {
	const country = cordisCountryCode(record.country)

	if (!country) return { refused: CORDISRefusal.CountryNotISO, country: null }

	if (!layoutForCountry(country)) return { refused: CORDISRefusal.CountryNoLayout, country }

	const name = fieldValue(record.name)
	const personal = naturalPersonForm(name, fieldValue(record.shortName), lexicon)

	if (personal) return { refused: personal, country }

	const locality = fieldValue(record.city)

	if (!locality) return { refused: CORDISRefusal.LocalityAbsent, country }

	const discarded: string[] = []
	const components: CanonicalRow["components"] = {}

	if (/\p{L}/u.test(name)) {
		components.venue = name
	}

	const streetLine = fieldValue(record.street)

	if (streetLine) {
		const split = splitCORDISStreetLine(streetLine, streetOrderForCountry(country))

		if (split && "refused" in split) return { refused: split.refused, country }

		if (split?.house_number) {
			components.house_number = split.house_number
		}

		if (split) {
			components.street = split.street
		}
	}

	const postcode = fieldValue(record.postCode)

	if (postcode && !/\d/u.test(postcode)) {
		discarded.push("component:postcode:no-digit")
	} else if (postcode && /^[0\s-]+$/u.test(postcode)) {
		discarded.push("component:postcode:zeroes")
	} else if (postcode) {
		components.postcode = postcode
	}

	if (!components.street && !components.postcode) return { refused: CORDISRefusal.ComponentsTooFew, country }

	components.locality = locality

	// The script is passed rather than left to the formatter.
	// That keeps a country's local order whenever its Latin order has fewer slots:
	// `Weixing Road` and `Changchun` would otherwise print run together in China's
	// Han-script line, with no separator between them.
	const rendered = formatAddressRow(components, country, {
		singleLine: true,
		script: scriptOfComponents(components),
	})

	if (!rendered) return { refused: CORDISRefusal.Unrenderable, country }

	const { raw, components: aligned } = rendered

	// Checked again on what the layout printed: Burkina Faso's layout has no postcode slot,
	// so `MINISTERE DE LA SANTE` with postcode `7003` and no street prints as a name and a city.
	if (!aligned.street && !aligned.postcode) return { refused: CORDISRefusal.ComponentsTooFew, country }

	// A layout with no slot for a component leaves it out of `raw`, as the United Arab Emirates'
	// leaves the locality, and the count records how often a published value went unwritten.
	for (const tag of rendered.unplaced) {
		discarded.push(`component:${tag}:unplaced`)
	}

	return {
		admitted: {
			raw,
			components: aligned,
			country,
			source: CORDIS_ADAPTER_ID,
			source_id: stableSourceID(CORDIS_ADAPTER_ID, aligned),
			corpus_version: "",
			license: CORDIS_LICENSE,
		},
		discarded,
	}
}

/**
 * One distinct published record and what it yielded.
 */
export interface CORDISRecordReading {
	readonly record: CORDISOrganizationRecord
	readonly reading: CORDISReading
}

/**
 * Every distinct published record under `inputPath`, read once each.
 *
 * A record is distinct on the five fields that reach a row, so an organization that took part in many
 * projects with one address is read once, and one whose address changed is read once per version.
 * `onDuplicate` is called once for every participation row a record already read covers.
 *
 * The adapter and the measurement both read through this, so the counts a
 * measurement reports are the adapter's own.
 */
export async function* readCORDISRecords(
	inputPath: PathBuilderLike,
	lexicon: PersonNameLexicon,
	options: { signal?: AbortSignal; onDuplicate?: () => void } = {}
): AsyncGenerator<CORDISRecordReading> {
	const seen = new Set<string>()

	for (const source of await cordisSources(inputPath)) {
		if (options.signal?.aborted) return

		const records = CSVSpliterator.fromAsync<CORDISOrganizationRecord>(
			source.archive ? readZipEntry(source.path, CORDIS_ORGANIZATION_MEMBER) : source.path,
			{ normalizeKeys: false, columnDelimiter: ";" }
		)

		let first = true

		for await (const record of records) {
			if (options.signal?.aborted) return

			if (first) {
				assertCORDISColumns(record, source.path)
				first = false
			}

			const key = [record.name, record.street, record.postCode, record.city, record.country]
				.map((value) => (value ?? "").replaceAll(/\s+/gu, " ").trim())
				.join("\u001F")

			if (seen.has(key)) {
				options.onDuplicate?.()

				continue
			}

			seen.add(key)

			yield { record, reading: readCORDISRecord(record, lexicon) }
		}
	}
}

/**
 * Raise when a record lacks a column the adapter indexes, naming the file and the missing columns.
 */
function assertCORDISColumns(record: CORDISOrganizationRecord, path: PathBuilderLike): void {
	const missing = CORDIS_REQUIRED_COLUMNS.filter((column) => !(column in record))

	if (missing.length) {
		throw new Error(
			`${CORDIS_ADAPTER_ID} adapter: ${PathBuilder.from(path).toString()} has no column ${missing.join(", ")}`
		)
	}
}

interface CORDISSource {
	readonly path: PathBuilderLike
	readonly archive: boolean
}

/**
 * Every input under `inputPath`: one archive, one extracted CSV, or a directory of archives.
 *
 * A directory is read in sorted name order, so a rerun meets the records in the
 * same order and keeps the same first copy.
 * A directory holding no archive raises rather than yielding zero rows.
 */
async function cordisSources(inputPath: PathBuilderLike): Promise<readonly CORDISSource[]> {
	const path = PathBuilder.from(inputPath)
	const basename = path.basename().toLowerCase()

	if (basename.endsWith(".zip")) return [{ path, archive: true }]

	if (basename.endsWith(".csv")) return [{ path, archive: false }]

	const names = await Globerator.from("*.zip", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${CORDIS_ADAPTER_ID} adapter: ${path.toString()} holds no .zip archive`)
	}

	return names.map((name) => ({ path: path(name), archive: true }))
}

export function createCORDISAdapter(): CorpusAdapter {
	return {
		id: CORDIS_ADAPTER_ID,
		defaultLicense: CORDIS_LICENSE,
		addressRole: AddressRole.RegisteredOffice,
		register: SourceRegister.CORDISParticipants,
		surface: SurfaceOrigin.Rendered,
		description:
			"CORDIS organization files (FP7, Horizon 2020, Horizon Europe): the registered addresses of EU research-programme participants.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const requested = opts.country ? opts.country.trim().toUpperCase() : undefined
			const lexicon = await loadPersonNameLexicon()
			const written = new Set<string>()

			let emitted = 0

			const readings = readCORDISRecords(opts.inputPath, lexicon, {
				signal: opts.signal,
				onDuplicate: () => countDropped(opts, "row:duplicate-record"),
			})

			for await (const { reading } of readings) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				if ("refused" in reading) {
					if (!requested || reading.country === requested) {
						countDropped(opts, `row:${reading.refused}`)
					}

					continue
				}

				const row = reading.admitted

				if (requested && row.country !== requested) continue

				for (const key of reading.discarded) {
					countDropped(opts, key)
				}

				const key = `${row.country}\u001E${row.raw}`

				if (written.has(key)) {
					countDropped(opts, "row:duplicate-address")

					continue
				}

				written.add(key)

				yield row

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const cordisAdapter = createCORDISAdapter()
