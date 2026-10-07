/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `gleif-lei`: the GLEIF Level 1 golden copy, read for the legal and headquarters addresses of the
 * legal entities that hold a Legal Entity Identifier.
 *
 * Input is the publisher's own LEI-CDF 3.1 CSV, one record per LEI, as
 * `https://goldencopy.gleif.org` serves it zipped. `opts.inputPath` is the `.csv.zip` archive, an
 * extracted `.csv`, or the directory `#tools/fetch/gleif` writes, in which case the newest archive
 * by its date-prefixed name is read. The CSV member is streamed out of the archive, so the several
 * gigabytes it decompresses to never sit on disk or in memory.
 *
 * ## License
 *
 * GLEIF's LEI Data Terms of Use, at {@linkcode GLEIF_LICENSE_URL}, read on 2026-10-03, state: "The
 * data available through the Access Service are provided under the CC0 licence, see CC0 1.0
 * Universal (CC0 1.0)." The Access Service is defined there as the facility that lets users "look-up
 * and/or download individual LEIs and/or related LE-RD and/or the entire set or a subset of LEIs",
 * which is the golden copy. GLEIF's open-data page states the same: "The data on GLEIF's website is
 * provided under a Creative Commons (CC0) license." The same terms ask a user not to create the
 * impression that derived data or services are provided or endorsed by GLEIF. That is why
 * {@linkcode GLEIF_ATTRIBUTION} credits the source rather than the corpus.
 *
 * ## Organization addresses only
 *
 * The register holds legal entities, and three of its fields identify an entity that is a natural
 * person trading in their own name. {@linkcode readGLEIFEntity} refuses each:
 *
 * 1. `Entity.EntityCategory` = `SOLE_PROPRIETOR`.
 * 2. `Entity.LegalForm.EntityLegalFormCode` naming an ISO 20275 form that is a sole
 *    proprietorship, from {@linkcode GLEIF_SOLE_PROPRIETOR_LEGAL_FORMS}. A registrant can file the
 *    form without the category, and the form is the registrar's own statement of what the entity is.
 * 3. `Entity.LegalForm.OtherLegalForm`, the free-text form a registrant writes where no ELF code
 *    fits, matching {@linkcode SOLE_PROPRIETOR_FORM_TEXT}: `SOLE TRADER`, `Ditta Individuale`,
 *    `Entreprise Individuelle`, `empresario individual`.
 *
 * No check on the legal name is applied. The `Surname, Firstname` test `it-anac` uses matched
 * company names here (`Experity, Inc`, `Octante, Lda`, `Slovalco, a.s.`) on nearly every hit, and the
 * category and form fields above are the registrant's and the LOU's own statement.
 *
 * `MailRouting` is never read into a row. It holds the care-of line, and on Scandinavian records it
 * holds a person's name: `c/o Marius Vinje`. A street line that opens with a care-of marker refuses the
 * address for the same reason.
 *
 * ## The street line
 *
 * `FirstAddressLine` holds the street and the number together, and `AddressNumber` repeats the
 * number on a minority of records. The split follows the country's own street order.
 * {@linkcode houseNumberLeadsStreet} reads that order from the layout `formatAddressRow` renders with.
 * A number-first country then takes `splitStreetLine` and a number-last country `splitTrailingStreetLine`.
 * Where the publisher's `AddressNumber` is present, the split must agree with it.
 *
 * Three normalizations run first. A copy of the publisher's own `City` value at the start or the end
 * of the line is removed, because several LOUs write `WARSZAWA PUŁAWSKA 182` with `City` `Warszawa`.
 * A civic-number marker is removed, so Romania's `Piata Presei Libere, nr. 3-5` splits to the street
 * `Piata Presei Libere` rather than `Piata Presei Libere, nr.`. A period closing a trailing number,
 * as Hungary writes `Bagoly utca 23.`, is removed. A whole line of the form `PO BOX 309` then
 * becomes `po_box` rather than a street.
 *
 * **A line holding a digit the split could not place refuses the address**, and so does a line with
 * no digit at all: in this register a digitless first line is as often a building (`UGLAND HOUSE`,
 * `KYDD BUILDING`) as a street, and no field separates the two. An English ordinal inside a street name
 * (`5TH AVENUE`) is a name rather than a number.
 *
 * The value the split leaves as `street` must then read as a street. It is refused where it still holds
 * a comma (`CAVES CORPORATE CENTRE, BUILDING 2` under the Bahamas' number-last layout), where it holds
 * a building or in-building word (`1302 DOMINION CENTRE`, `903 PLATINUM TOWER`, `APTO 2`), and where it
 * is only a generic word (`910 Street`). Each of those numbers a room, an office or a building, and
 * labeling it `house_number` beside a building name labeled `street` would teach the wrong boundary.
 *
 * `AdditionalAddressLine.1`–`3` mix building names, districts, floors and second street lines, and
 * no field states which, so they reach no row. The golden copy's "AddressNumberWithinBuilding" field becomes `unit` when it
 * holds a letter, as `Suite 4` does. A bare number there would render as a second house number.
 *
 * ## Region
 *
 * `Region` is an ISO 3166-2 code such as `SK-KI`, which is not how an address writes the region.
 * It reaches a row only where the code's suffix is the written form.
 * `matchSubdivisionIn` answers for the United States, Canada and Australia. A code whose
 * country prefix differs from `Country` refuses the address as contradicting it.
 *
 * ## One row per address
 *
 * Registered agents give one address to thousands of entities. The adapter emits each rendered
 * address once per country: the key is the address rendered without its venue, and the first
 * entity read at that address keeps the venue. The headquarters address is read only where it
 * differs from the legal address in some field.
 *
 * Only a country for which `layoutForCountry` returns a layout is emitted.
 *
 * The adapter honors `opts.limit`, `opts.signal` and `opts.country`, and counts every refusal in
 * `opts.dropped`.
 */

import { formatAddressRow, scriptOfComponents } from "@mailwoman/codex/address/format"
import { type AddressScript, layoutForCountry } from "@mailwoman/codex/address/layouts"
import { isAlpha2CodeShape, matchSubdivisionIn } from "@mailwoman/codex/country"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { splitStreetLine, splitTrailingStreetLine } from "#adapters/street-line"
import { FingerprintSet } from "#fingerprints"
import { isPlaceholderValue } from "#it/adapters/anac/adapter"
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
 * Registry id for this adapter, stamped into every row it emits.
 */
export const GLEIF_ADAPTER_ID = "gleif-lei"

/**
 * Countries whose sampled rows show a labeling defect the street split cannot detect,
 * so none of their rows is emitted until the split handles them.
 *
 * - `AE`: the first address line is often an office or unit number before a building name,
 *   as in `601 سويس تاور` and `501 LE SOLARIUM`, which the split reads as a house number and a street.
 * - `HK`: a floor such as `6F` comes out as the house number, as in `6F MANULIFE PLACE`.
 * - `BS`: codex records the Bahamas as number-last while its published lines are number-first
 *   (`1 Montague Place`), and a `# 207` suite marker stays inside the street.
 */
export const GLEIF_UNREVIEWED_COUNTRIES: ReadonlySet<string> = new Set(["AE", "HK", "BS"])

/**
 * The license GLEIF's LEI Data Terms of Use state for the golden copy.
 */
export const GLEIF_LICENSE = "CC0-1.0"

/**
 * The page that states {@linkcode GLEIF_LICENSE}.
 */
export const GLEIF_LICENSE_URL = "https://www.gleif.org/en/meta/lei-data-terms-of-use"

/**
 * The credit a model card includes.
 *
 * CC0 requires none.
 * The terms ask that no derived product imply GLEIF's endorsement, so the credit
 * states the source and claims no relationship with GLEIF.
 */
export const GLEIF_ATTRIBUTION = "Global Legal Entity Identifier Foundation (GLEIF), LEI golden copy (CC0 1.0)"

/**
 * The publisher's file name for a Level 1 golden copy in CSV, date- and time-prefixed.
 */
export const GLEIF_ARCHIVE_PATTERN = /^\d{8}-\d{4}-gleif-goldencopy-lei2-golden-copy\.csv\.zip$/u

/**
 * ISO 20275 Entity Legal Form codes whose form is a natural person trading in their own name.
 *
 * Each code is one the golden copy files under the `SOLE_PROPRIETOR` category, and each is kept
 * because its name in GLEIF's ELF code list v1.6 (2026-02-19) states that form: `4QIE` is India's
 * `Sole Proprietorship`, `ZVVM` Poland's `osoby fizyczne prowadzące działalność gospodarczą`,
 * `OL20` Germany's `Einzelunternehmen, eingetragener Kaufmann`, `RV48` China's `个体工商户`.
 * Two codes filed under the category are left out because the list describes each as a company:
 * `HA2W` (Oman, a one-person company) and `AL8W` (Brazil, `Sociedade Limitada Unipessoal`).
 */
export const GLEIF_SOLE_PROPRIETOR_LEGAL_FORMS: ReadonlySet<string> = new Set([
	"1CML",
	"1SL4",
	"2IGL",
	"3N94",
	"3UPJ",
	"456Q",
	"4QIE",
	"4QXM",
	"946C",
	"95G8",
	"9D9U",
	"AZA0",
	"BJ8Q",
	"C4PZ",
	"ECWU",
	"EV7F",
	"EXD7",
	"FJQ8",
	"FUKI",
	"K09E",
	"LHBB",
	"MV4S",
	"MXLT",
	"NFDF",
	"OL20",
	"P9CF",
	"QW8S",
	"RV48",
	"UR1O",
	"VALH",
	"W8V9",
	"ZVVM",
	"ZY9X",
])

/**
 * The free-text legal forms that state a natural person trading in their own name.
 */
const SOLE_PROPRIETOR_FORM_TEXT =
	/\b(?:sole\s+(?:trader|proprietor(?:ship)?)|individuals?\s+acting\s+in\s+a\s+business\s+capacity|ditta\s+individuale|impresa\s+individuale|entreprise\s+individuelle|empresario\s+individual|einzel(?:unternehmen|unternehmer(?:in)?|kauf(?:mann|frau))|enkeltmandsvirksomhed|enskild\s+(?:firma|näringsidkare)|enkeltpersonforetak|eenmanszaak|egyéni\s+vállalkozó)\b/iu

/**
 * Why an entity or one of its addresses did not become a row.
 */
export const GLEIFRefusal = {
	/**
	 * The country is in {@link GLEIF_UNREVIEWED_COUNTRIES}.
	 */
	CountryUnreviewed: "country-unreviewed",
	/**
	 * `Entity.EntityCategory` is `SOLE_PROPRIETOR`.
	 */
	SoleProprietorCategory: "sole-proprietor-category",
	/**
	 * The ELF code is a sole-proprietorship form.
	 */
	SoleProprietorLegalForm: "sole-proprietor-legal-form",
	/**
	 * The free-text legal form states a sole proprietorship.
	 */
	SoleProprietorFormText: "sole-proprietor-form-text",
	/**
	 * The address states no country.
	 */
	CountryAbsent: "country-absent",
	/**
	 * The country is not an ISO 3166-1 alpha-2 code.
	 */
	CountryNotAlpha2: "country-not-alpha-2",
	/**
	 * The ISO 3166-2 region code's country prefix differs from `Country`.
	 */
	RegionContradictsCountry: "region-contradicts-country",
	/**
	 * Codex holds no layout for the country, so no address line can be rendered.
	 */
	CountryWithoutLayout: "country-without-layout",
	/**
	 * The address states no city.
	 */
	LocalityAbsent: "locality-absent",
	/**
	 * The address states no first line.
	 */
	StreetLineAbsent: "street-line-absent",
	/**
	 * The first line opens with a care-of marker, so it identifies the recipient rather than the place.
	 */
	CareOfLine: "care-of-line",
	/**
	 * The first line holds no digit, so it cannot be told from a building name.
	 */
	StreetLineWithoutNumber: "street-line-without-number",
	/**
	 * The first line holds a digit the split could not place as a house number.
	 */
	StreetNumberUnplaced: "street-number-unplaced",
	/**
	 * The street the split left still holds a comma, so the line joins several parts
	 * (a building, a district, a floor) and the split cannot say which part is the street.
	 */
	StreetLineSegmented: "street-line-segmented",
	/**
	 * The street the split left is a building or a place inside one
	 * (`PLATINUM TOWER`, `NINTH FLOOR`, `APTO`), so the number beside it numbers a room,
	 * an office or a building rather than a premise on a street.
	 */
	StreetHoldsPremiseWord: "street-holds-premise-word",
	/**
	 * The street the split left is only a generic word, as Qatar's `910 Street` leaves `Street`.
	 */
	StreetNameGenericOnly: "street-name-generic-only",
	/**
	 * The split's house number disagrees with the publisher's own `AddressNumber`.
	 */
	StreetNumberDisagrees: "street-number-disagrees",
	/**
	 * The components do not render under the country's layout.
	 */
	Unrenderable: "unrenderable",
	/**
	 * The rendered line holds fewer than two address components besides the venue.
	 */
	ComponentsTooFew: "components-too-few",
} as const

/**
 * One of the {@link GLEIFRefusal} reasons.
 */
export type GLEIFRefusal = (typeof GLEIFRefusal)[keyof typeof GLEIFRefusal]

/**
 * The two address blocks a record holds for its entity.
 */
export const GLEIFAddressBlock = {
	Legal: "LegalAddress",
	Headquarters: "HeadquartersAddress",
} as const

/**
 * One of the {@link GLEIFAddressBlock} values.
 */
export type GLEIFAddressBlock = (typeof GLEIFAddressBlock)[keyof typeof GLEIFAddressBlock]

/**
 * One CSV record, keyed by the publisher's own column names.
 */
export type GLEIFRecord = Readonly<Record<string, string | undefined>>

/**
 * What one address block yielded: a row, or the reason it yielded none.
 */
export type GLEIFAddressReading = { readonly admitted: CanonicalRow } | { readonly refused: GLEIFRefusal }

/**
 * The address fields a block holds, in the order the CDF lists them.
 */
const ADDRESS_FIELDS = [
	"FirstAddressLine",
	"AddressNumber",
	"AddressNumberWithinBuilding",
	"MailRouting",
	"AdditionalAddressLine.1",
	"AdditionalAddressLine.2",
	"AdditionalAddressLine.3",
	"City",
	"Region",
	"Country",
	"PostalCode",
] as const

/**
 * The columns every read depends on, checked against the first record so a renamed
 * column fails the run rather than refusing every record.
 */
const REQUIRED_COLUMNS = [
	"LEI",
	"Entity.LegalName",
	"Entity.EntityCategory",
	"Entity.LegalForm.EntityLegalFormCode",
	"Entity.LegalForm.OtherLegalForm",
	...ADDRESS_FIELDS.map((field) => `Entity.${GLEIFAddressBlock.Legal}.${field}`),
	...ADDRESS_FIELDS.map((field) => `Entity.${GLEIFAddressBlock.Headquarters}.${field}`),
]

/**
 * A care-of or attention marker opening a line.
 */
const CARE_OF = /^(?:c\s*\/\s*o\b|c\/-|care\s+of\b|attn\b|attention\b)/iu

/**
 * A whole line that is a post-office box, as `PO BOX 309`, `P.O. Box 10240` or `P O BOX 472`.
 */
const PO_BOX_LINE = /^(?:p\.?\s?o\.?\s?box|post\s+office\s+box)\s*(?:no\.?\s*)?\d+[a-z]?$/iu

/**
 * An English ordinal written in digits, such as `5TH`, is part of the street name.
 */
const ORDINAL_TOKEN = /\b\d+(?:st|nd|rd|th)\b/giu

/**
 * A leading house number closed by a comma, as in `49, AVENUE JOHN F. KENNEDY`.
 */
const LEADING_NUMBER_COMMA = /^(\d+(?:-\d+)?[A-Za-z]?)\s*,\s*(?=\S)/u

/**
 * A civic-number marker before the number, as Romania's `Piata Presei Libere, nr. 3-5`
 * and `Str Pacurari nr.128` write it, with the comma or space that precedes it.
 *
 * The marker must start its own token and be followed by a digit, so a street
 * whose name ends in `NO` or `NR` keeps it.
 */
const CIVIC_MARKER = /[\s,]*(?<=^|[\s,])(?:nr|no|n°|nº)\.?\s*(?=\d)/giu

/**
 * A word for a building or a place inside one, written in English or in the Spanish
 * and Italian forms the offshore registers use.
 *
 * A street holding one is refused rather than labeled: `1302 DOMINION CENTRE`, `903 PLATINUM TOWER`,
 * `CAVES CORPORATE CENTRE, BUILDING 2` and `APTO 2` each number a room, an office or a building.
 */
const PREMISE_WORD =
	/\b(?:building|bldg|tower|centre|center|plaza|house|complex|chambers|palazzo|edificio|torre|floor|level|suite|room|office|unit|apto|apt|piso|block|lot|plot|box|km)\b/iu

/**
 * A house number that holds only zeros.
 */
const ZERO_NUMBER = /^0+$/u

/**
 * A street name that is only a generic word, as a number-first split of `910 Street` leaves it.
 */
const GENERIC_ONLY = /^(?:street|road|avenue|st|rd|ave)\.?$/iu

/**
 * A period closing a trailing house number, as Hungary writes `Bagoly utca 23.`.
 */
const TRAILING_NUMBER_PERIOD = /(\d[\dA-Za-z/-]*)\.$/u

/**
 * A published value with whitespace collapsed, or an empty string for an absent or placeholder value.
 */
function fieldValue(value: string | null | undefined): string {
	const trimmed = (value ?? "").replaceAll(/\s+/gu, " ").trim()

	return isPlaceholderValue(trimmed) ? "" : trimmed
}

function addressField(record: GLEIFRecord, block: GLEIFAddressBlock, field: (typeof ADDRESS_FIELDS)[number]): string {
	return fieldValue(record[`Entity.${block}.${field}`])
}

/**
 * Whether the entity is a natural person trading in their own name, or otherwise refused whole.
 *
 * @returns The refusal, or `null` for an entity whose addresses may be read.
 */
export function readGLEIFEntity(record: GLEIFRecord): GLEIFRefusal | null {
	if (fieldValue(record["Entity.EntityCategory"]).toUpperCase() === "SOLE_PROPRIETOR") {
		return GLEIFRefusal.SoleProprietorCategory
	}

	if (GLEIF_SOLE_PROPRIETOR_LEGAL_FORMS.has(fieldValue(record["Entity.LegalForm.EntityLegalFormCode"]))) {
		return GLEIFRefusal.SoleProprietorLegalForm
	}

	if (SOLE_PROPRIETOR_FORM_TEXT.test(fieldValue(record["Entity.LegalForm.OtherLegalForm"]))) {
		return GLEIFRefusal.SoleProprietorFormText
	}

	return null
}

/**
 * Whether the headquarters block states the same address as the legal block, field for field.
 */
export function headquartersRepeatsLegal(record: GLEIFRecord): boolean {
	return ADDRESS_FIELDS.every(
		(field) =>
			addressField(record, GLEIFAddressBlock.Legal, field) ===
			addressField(record, GLEIFAddressBlock.Headquarters, field)
	)
}

const numberOrderCache = new Map<string, boolean | null>()

/**
 * Whether the country's layout, in `script`, writes the house number before the street name.
 *
 * Read off the layout `formatAddressRow` renders with, so the split and the render cannot disagree.
 *
 * @returns `null` where the layout prints no street line.
 */
export function houseNumberLeadsStreet(country: string, script: AddressScript | null = null): boolean | null {
	const key = `${country}:${script ?? ""}`
	const cached = numberOrderCache.get(key)

	if (cached !== undefined) return cached

	const probe = formatAddressRow({ house_number: "9", street: "Q" }, country, { singleLine: true, script })

	const leads =
		probe?.components.house_number && probe.components.street ? probe.raw.indexOf("9") < probe.raw.indexOf("Q") : null

	numberOrderCache.set(key, leads)

	return leads
}

/**
 * The first line with a leading or trailing copy of the publisher's own city removed,
 * a civic-number marker removed, and a period closing a trailing number removed.
 *
 * The city copy is removed only where it equals the `City` field, folded for case,
 * so the publisher's record authorizes the removal rather than a place-name list.
 */
export function normalizeGLEIFStreetLine(line: string, city: string): string {
	let work = line.replaceAll(/\s+/gu, " ").trim()
	const foldedCity = city.replaceAll(/\s+/gu, " ").trim().toLocaleUpperCase()
	const folded = work.toLocaleUpperCase()

	if (foldedCity && folded !== foldedCity && folded.startsWith(`${foldedCity} `)) {
		work = work.slice(foldedCity.length).replace(/^[\s,.-]+/u, "")
	} else if (foldedCity && folded !== foldedCity && folded.endsWith(` ${foldedCity}`)) {
		work = work.slice(0, work.length - foldedCity.length).replace(/[\s,.-]+$/u, "")
	}

	return work
		.replace(/[\s,]+$/u, "")
		.replaceAll(CIVIC_MARKER, " ")
		.replace(TRAILING_NUMBER_PERIOD, "$1")
		.replaceAll(/\s+/gu, " ")
		.trim()
}

/**
 * Read one address block into a row, or report why it yielded none.
 *
 * Exported because the refusal reasons are the measurement the adapter is checked by.
 * The entity-level refusals of {@linkcode readGLEIFEntity} are the caller's to apply first.
 */
export function readGLEIFAddress(record: GLEIFRecord, block: GLEIFAddressBlock): GLEIFAddressReading {
	// Read without the placeholder filter, because `NA` is Namibia's code rather than an absent value.
	const country = (record[`Entity.${block}.Country`] ?? "").trim().toUpperCase()

	if (!country) return { refused: GLEIFRefusal.CountryAbsent }

	if (!isAlpha2CodeShape(country)) return { refused: GLEIFRefusal.CountryNotAlpha2 }

	const regionCode = addressField(record, block, "Region").toUpperCase()

	// ISO 3166-2:FR also codes the overseas collectivities by their own alpha-2,
	// as `FR-PF` for French Polynesia, so that code agrees with `Country` `PF`.
	if (regionCode && !regionCode.startsWith(`${country}-`) && regionCode !== `FR-${country}`) {
		return { refused: GLEIFRefusal.RegionContradictsCountry }
	}

	if (!layoutForCountry(country)) return { refused: GLEIFRefusal.CountryWithoutLayout }

	if (GLEIF_UNREVIEWED_COUNTRIES.has(country)) return { refused: GLEIFRefusal.CountryUnreviewed }

	const city = addressField(record, block, "City")

	if (!city) return { refused: GLEIFRefusal.LocalityAbsent }

	const firstLine = addressField(record, block, "FirstAddressLine")

	if (!firstLine) return { refused: GLEIFRefusal.StreetLineAbsent }

	if (CARE_OF.test(firstLine)) return { refused: GLEIFRefusal.CareOfLine }

	const line = normalizeGLEIFStreetLine(firstLine, city)
	const components: CanonicalRow["components"] = {}
	const name = fieldValue(record["Entity.LegalName"])

	if (name && /\p{L}/u.test(name)) {
		components.venue = name
	}

	const script = scriptOfComponents({ street: line, locality: city })

	if (PO_BOX_LINE.test(line)) {
		components.po_box = line
	} else {
		const placed = placeStreetNumber(line, addressField(record, block, "AddressNumber"), country, script)

		if ("refused" in placed) return placed

		if (placed.house_number) {
			components.house_number = placed.house_number
		}

		components.street = placed.street

		const unit = addressField(record, block, "AddressNumberWithinBuilding")

		if (unit && /\p{L}/u.test(unit) && !unit.includes(",") && !line.includes(unit)) {
			components.unit = unit
		}
	}

	const postcode = addressField(record, block, "PostalCode")

	if (postcode) {
		components.postcode = postcode
	}

	components.locality = city

	if (regionCode) {
		const suffix = regionCode.slice(country.length + 1)

		if (matchSubdivisionIn(country, suffix)) {
			components.region = suffix
		}
	}

	const rendered = formatAddressRow(components, country, { singleLine: true, script })

	if (!rendered) return { refused: GLEIFRefusal.Unrenderable }

	const { raw, components: aligned } = rendered

	if (Object.keys(aligned).filter((tag) => tag !== "venue").length < 2) {
		return { refused: GLEIFRefusal.ComponentsTooFew }
	}

	return {
		admitted: {
			raw,
			components: aligned,
			country,
			source: GLEIF_ADAPTER_ID,
			source_id: stableSourceID(GLEIF_ADAPTER_ID, { country, ...aligned }),
			corpus_version: "",
			license: GLEIF_LICENSE,
			addressRole: block === GLEIFAddressBlock.Legal ? AddressRole.RegisteredOffice : AddressRole.Facility,
		},
	}
}

/**
 * Split a street line into its street and house number by the country's order,
 * checking the split against the publisher's `AddressNumber` where it states one.
 */
function placeStreetNumber(
	line: string,
	addressNumber: string,
	country: string,
	script: AddressScript | null
): { street: string; house_number?: string } | { refused: GLEIFRefusal } {
	const unplacedDigit = (street: string): boolean => /\d/u.test(street.replaceAll(ORDINAL_TOKEN, ""))

	// A number of zeros is a registrant's placeholder for none, as
	// `ELIZABETH AVENUE AND SHIRLEY STREET` with `AddressNumber` `0` shows.
	if (ZERO_NUMBER.test(addressNumber)) {
		addressNumber = ""
	}

	if (!/\d/u.test(line)) {
		if (!addressNumber || !/\d/u.test(addressNumber)) return { refused: GLEIFRefusal.StreetLineWithoutNumber }

		// A digitless line with the number in its own column is the number's street.
		const refusal = streetRefusal(line)

		return refusal ? { refused: refusal } : { street: line, house_number: addressNumber }
	}

	const leads = houseNumberLeadsStreet(country, script)

	if (leads === null) return { refused: GLEIFRefusal.Unrenderable }

	// A number-first line may close the number with a comma, as Luxembourg's
	// `49, AVENUE JOHN F. KENNEDY` does.
	// The layout renders its own separator.
	// The comma stays out of the component.
	const split = leads ? splitStreetLine(line.replace(LEADING_NUMBER_COMMA, "$1 ")) : splitTrailingStreetLine(line)

	if (!split?.house_number || ZERO_NUMBER.test(split.house_number) || unplacedDigit(split.street)) {
		return { refused: GLEIFRefusal.StreetNumberUnplaced }
	}

	const refusal = streetRefusal(split.street)

	if (refusal) return { refused: refusal }

	if (addressNumber && !numberAgrees(split.house_number, addressNumber)) {
		return { refused: GLEIFRefusal.StreetNumberDisagrees }
	}

	return { street: split.street, house_number: split.house_number }
}

/**
 * Why a value about to be labeled `street` is not a street name, or `null` where it may be one.
 */
function streetRefusal(street: string): GLEIFRefusal | null {
	if (street.includes(",")) return GLEIFRefusal.StreetLineSegmented

	if (PREMISE_WORD.test(street)) return GLEIFRefusal.StreetHoldsPremiseWord

	if (GENERIC_ONLY.test(street)) return GLEIFRefusal.StreetNameGenericOnly

	return null
}

/**
 * Whether a split's house number is the publisher's `AddressNumber`, or that number
 * with a subdivision joined to it, as `1A/3` is to `1A`.
 */
function numberAgrees(split: string, published: string): boolean {
	const a = split.toUpperCase()
	const b = published.replaceAll(/\s+/gu, "").toUpperCase()

	return a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}-`)
}

/**
 * The key one rendered address is emitted under: the country and the address rendered without its venue.
 */
function addressKey(row: CanonicalRow): string {
	const { venue: _venue, ...address } = row.components
	const rendered = formatAddressRow(address, row.country, { singleLine: true })

	return `${row.country}\u001E${(rendered?.raw ?? row.raw).toLowerCase()}`
}

/**
 * The slot count of the fingerprint table the address keys are held in, as a base-2 logarithm.
 *
 * 2^24 slots hold 11,744,051 keys at the table's load limit in 256 MiB,
 * three times the golden copy's 3,451,350 records on 2026-10-03.
 */
const ADDRESS_KEY_SLOTS_LOG2 = 24

export function createGLEIFAdapter(): CorpusAdapter {
	return {
		id: GLEIF_ADAPTER_ID,
		defaultLicense: GLEIF_LICENSE,
		addressRole: AddressRole.RegisteredOffice,
		register: SourceRegister.GLEIFGoldenCopy,
		surface: SurfaceOrigin.Rendered,
		description:
			"GLEIF LEI golden copy (CC0): the legal and headquarters addresses of legal entities, one row per address.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const wanted = opts.country?.toUpperCase()

			if (wanted && !layoutForCountry(wanted)) {
				throw new UnsupportedCountryError(GLEIF_ADAPTER_ID, ["any country codex holds a layout for"], wanted)
			}

			const emitted = new FingerprintSet(ADDRESS_KEY_SLOTS_LOG2)
			let count = 0
			let checkedHeader = false

			for await (const record of readGLEIFRecords(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && count >= opts.limit) break

				if (!checkedHeader) {
					checkedHeader = true
					assertColumns(record, opts.inputPath)
				}

				const entityRefusal = readGLEIFEntity(record)

				if (entityRefusal) {
					countDropped(opts, `record:${entityRefusal}`)

					continue
				}

				const blocks: GLEIFAddressBlock[] = [GLEIFAddressBlock.Legal]

				if (headquartersRepeatsLegal(record)) {
					countDropped(opts, "kept:headquarters-repeats-legal")
				} else {
					blocks.push(GLEIFAddressBlock.Headquarters)
				}

				for (const block of blocks) {
					if (opts.limit !== undefined && count >= opts.limit) break

					const reading = readGLEIFAddress(record, block)

					if ("refused" in reading) {
						countDropped(opts, `row:${reading.refused}`)

						continue
					}

					const row = reading.admitted

					if (wanted && row.country !== wanted) continue

					if (!emitted.add(addressKey(row))) {
						countDropped(opts, "row:address-already-emitted")

						continue
					}

					yield row

					count++
				}
			}
		},
	}
}

function assertColumns(record: GLEIFRecord, inputPath: PathBuilderLike): void {
	const present = new Set(Object.keys(record))
	const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column))

	if (!missing.length) return

	throw new Error(
		`${GLEIF_ADAPTER_ID} adapter: ${inputPath.toString()} carries none of ${missing.join(", ")}. ` +
			`Every record would be refused. Check the publisher's LEI-CDF column names against this adapter's.`
	)
}

/**
 * The records under `inputPath`, which is an archive, an extracted CSV, or a directory holding archives.
 *
 * A directory holding no archive raises rather than yielding zero rows.
 */
async function* readGLEIFRecords(inputPath: PathBuilderLike): AsyncGenerator<GLEIFRecord> {
	const path = await resolveGLEIFInput(inputPath)
	const options = { normalizeKeys: false } as const
	const source = path.basename().toLowerCase().endsWith(".zip") ? readZipEntry(path, /\.csv$/iu) : path

	yield* CSVSpliterator.fromAsync<Record<string, string>>(source, options)
}

async function resolveGLEIFInput(inputPath: PathBuilderLike): Promise<PathBuilder> {
	const path = PathBuilder.from(inputPath)
	const name = path.basename().toLowerCase()

	if (name.endsWith(".zip") || name.endsWith(".csv")) return path

	const archives = (await Globerator.from("*.csv.zip", { cwd: path.toString(), absolute: false }).toSorted()).filter(
		(archive) => GLEIF_ARCHIVE_PATTERN.test(archive)
	)

	if (!archives.length) {
		throw new Error(`${GLEIF_ADAPTER_ID} adapter: ${path.toString()} holds no golden-copy archive`)
	}

	return path(archives.at(-1)!)
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const gleifAdapter = createGLEIFAdapter()
