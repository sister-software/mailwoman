/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `fr-finess-overseas`: the health and social establishments of France's overseas jurisdictions,
 * read from the FINESS establishment extract that the health ministry publishes on data.gouv.fr.
 *
 * Input is the publisher's `etalab-cs1100502-stock-<date>.csv`, the resource titled `Extraction
 * Finess des Etablissements` on `https://www.data.gouv.fr/datasets/finess-extraction-du-fichier-des-etablissements`.
 * The file is UTF-8 and semicolon-separated with RFC 4180 quoting. The publisher's description
 * (`etalab_cs1100502.pdf`) states tab-separated, and the file does not follow it. Line 1 is a comment
 * (`finess;etalab;111;2026-05-12`) and every other line opens with `structureet`. The adapter reads
 * the positional columns the description numbers: 4 `rs`, 5 `rslongue`, 8 `numvoie`, 9 `typvoie`, 10
 * `voie`, 11 `compvoie`, 12 `lieuditbp`, 14 `departement`, 16 `ligneacheminement` and 19
 * `categetab`, counted from 1. {@linkcode FinessColumn} holds them counted from 0.
 *
 * The publisher froze this extract at data dated 2026-05-04 and states on the dataset page that it
 * will not be updated again. Its successor is the Agence du Numérique en Santé's `FINESS -
 * Structures` JSON flow, a different schema this adapter does not read.
 *
 * ## Which rows are read
 *
 * `departement` holds a two-character code, and the overseas ones are `9A` Guadeloupe, `9B`
 * Martinique, `9C` Guyane, `9D` La Réunion, `9E` Saint-Pierre-et-Miquelon, `9F` Mayotte and `9J`
 * Wallis-et-Futuna. Saint-Barthélemy and Saint-Martin have no code of their own: their
 * establishments sit under `9A`, and the postcodes 97133 and 97150 separate them, so the adapter
 * assigns those two postcodes to BL and MF. A metropolitan row is refused under
 * {@linkcode FinessRefusal.NotOverseas}, which on the 2026-05-04 extract is most of the file.
 *
 * ## Organizations only
 *
 * Every FINESS establishment is an organization's site: a hospital, a pharmacy, a laboratory, a
 * service office. Three categories house the people they serve in a private dwelling. In `462`
 * Lieux de vie et d'accueil the staff live with the people they receive. A `238` Centre d'accueil
 * familial spécialisé places patients with host families, as a `236` Service de placement familial
 * does. An address in those three can be a family's home, so they are refused under
 * {@linkcode FinessRefusal.FamilyPlacement}, as is an establishment whose name states family
 * placement or a lieu de vie under another category. A row whose street type is TRE-R35's `CHEZ`,
 * or whose line opens with `CHEZ`, gives the person whose premises it is and is refused under
 * {@linkcode FinessRefusal.CareOfPerson}.
 *
 * ## The street line
 *
 * `numvoie` is the number, `compvoie` its repetition index, `typvoie` a TRE-R35 street-type code and
 * `voie` the name. The code is expanded by {@linkcode expandFinessVoieType} and written first, as
 * French addresses write it: `R` and `DE PARIS` print `RUE DE PARIS`. The word takes the name's
 * case, so an all-capitals name keeps an all-capitals line. A name that already opens with the type
 * word (`CHE` and `CHEMIN SAFER MORANGE`) is not given it twice, and a name with no code is split by
 * {@linkcode splitFrenchStreetType}, which reads the BAN adapter's street-type dictionary first.
 *
 * `compvoie` is one of `B`, `T`, `Q` or `C`. The first three are bis, ter and quater. `C` is
 * refused under {@linkcode FinessRefusal.RepetitionIndexAmbiguous}: INSEE's coding reads it as
 * quinquies, and the national extract holds 133 `C` against 31 `Q`, which is not the ratio of a
 * fifth repetition to a fourth and reads as a letter suffix entered in the index field.
 *
 * A digit in `voie` is refused under {@linkcode FinessRefusal.StreetDigitUnplaced} unless the digits
 * name the street, as a numbered route (`NATIONALE 2`) or a date (`DU 22 MAI`) does. The number has
 * its own field, so a digit left in the name is a box, a building or a door: `VALLÉE 3 BP 208`,
 * `DIAKA BAT A4 PORTE 2`.
 *
 * ## The lieu-dit and box line, and the routing line
 *
 * `lieuditbp` holds a lieu-dit, a post-office box, or both (`ZA ESPERANCE - BP 26`). The box becomes
 * `po_box` and the rest `dependent_locality`. A remainder that writes the same place as the locality
 * or the street is dropped, and one holding a digit is refused under
 * {@linkcode FinessRefusal.LieuDitDigitUnplaced}, because `1ER ETAGE MONTGERALD` and `VILLA N° 3`
 * name a floor and a building rather than a place. A remainder that opens with a building, floor or
 * landmark word (`IMMEUBLE SEMAFA`, `ANGLE DES RUES JEAN JAURES`) is left out of the row and counted
 * under {@linkcode FinessTrim.LieuDitPremiseDescriptor}, because the row stays an address without it.
 *
 * `ligneacheminement` is La Poste's routing line, `97100 BASSE TERRE` or `97331 CAYENNE CEDEX`. It
 * gives the postcode, the locality as La Poste routes it and the `cedex` phrase. Every codex layout
 * this adapter emits prints that phrase after the locality. French Polynesia is the exception.
 *
 * ## Identity and license
 *
 * The row id is content-addressed over the aligned components, so two establishments at one address
 * under one name are one row. FINESS numbers identify establishments rather than addresses.
 *
 * data.gouv.fr publishes the dataset under the license whose id is `fr-lo`, titled `Licence Ouverte /
 * Open Licence`, and links its text at
 * `https://www.etalab.gouv.fr/wp-content/uploads/2014/05/Licence_Ouverte.pdf`. That is version 1.0
 * of October 2011. It grants the reuser the right to « Adapter, modifier, extraire et
 * transformer à partir de « l'Information », notamment pour créer des « Informations dérivées » »,
 * « Sous réserve de : Mentionner la paternité de « l'Information » : sa source (a minima le nom du
 * « Producteur ») et la date de sa dernière mise à jour. » Every row records that license, and
 * {@linkcode FR_FINESS_ATTRIBUTION} is the credit. The model card completes it with the
 * extraction date the fetch manifest records.
 *
 * The adapter honors `opts.limit`, `opts.signal` and `opts.country`, and counts every refusal
 * under its reason in `opts.dropped`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { composeHouseNumber } from "#adapters/street-line"
import { isPremiseDescriptor, isSamePlace, parseAcheminementLine, splitPostBox } from "#fr/adapters/finess/postal-lines"
import {
	CARE_OF_VOIE_TYPE,
	expandFinessVoieType,
	isStreetNameDigitPlaced,
	splitFrenchStreetType,
} from "#fr/adapters/finess/voie-type"
import { SourceRegister } from "#registers"
import {
	AddressRole,
	type AdapterOptions,
	type CanonicalRow,
	countDropped,
	type CorpusAdapter,
	SurfaceOrigin,
} from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const FR_FINESS_ADAPTER_ID = "fr-finess-overseas"

/**
 * The license data.gouv.fr states for the dataset: `fr-lo`, Licence Ouverte / Open Licence version 1.0.
 */
export const FR_FINESS_LICENSE = "Licence Ouverte 1.0"

/**
 * The credit Licence Ouverte requires: the producer's name, beside the date of the data's last update.
 */
export const FR_FINESS_ATTRIBUTION =
	"FINESS, Ministère des Solidarités et de la Santé, via data.gouv.fr (finess-extraction-du-fichier-des-etablissements)"

/**
 * The jurisdiction each overseas `departement` code belongs to.
 *
 * `9A` also holds Saint-Barthélemy and Saint-Martin. {@linkcode FINESS_COUNTRY_BY_POSTCODE} separates them.
 */
export const FINESS_COUNTRY_BY_DEPARTEMENT: Readonly<Record<string, string>> = {
	"9A": "GP",
	"9B": "MQ",
	"9C": "GF",
	"9D": "RE",
	"9E": "PM",
	"9F": "YT",
	"9J": "WF",
}

/**
 * The two Guadeloupe-coded postcodes that belong to separate jurisdictions.
 */
export const FINESS_COUNTRY_BY_POSTCODE: Readonly<Record<string, string>> = {
	"97133": "BL",
	"97150": "MF",
}

/**
 * Every jurisdiction this adapter can emit.
 */
export const FR_FINESS_COUNTRIES: readonly string[] = [
	...new Set([...Object.values(FINESS_COUNTRY_BY_DEPARTEMENT), ...Object.values(FINESS_COUNTRY_BY_POSTCODE)]),
]

/**
 * The establishment categories whose address can be a private dwelling: lieux de vie et
 * d'accueil, centres d'accueil familial spécialisés and services de placement familial.
 */
export const FINESS_FAMILY_PLACEMENT_CATEGORIES: ReadonlySet<string> = new Set(["236", "238", "462"])

/**
 * An establishment name that states family placement, for one filed under another category.
 *
 * Saint-Pierre-et-Miquelon's `CENTRE D'ACCUEIL FAMILIAL SPECIALISE` is filed under `377`,
 * Etablissement expérimental pour enfance handicapée, so the category list would admit it without
 * the name check.
 */
const FAMILY_PLACEMENT_NAME = /\b(?:accueil|placement) famil|\blieux? de vie\b/iu

/**
 * The positions, counted from 0, of the columns this adapter reads. Each entry gives the
 * publisher's column name and what the column holds.
 */
export const FinessColumn = {
	/**
	 * `section`, which is `structureet` on every establishment line.
	 */
	Section: 0,
	/**
	 * `rs`, the establishment's name, truncated by the publisher to 38 characters.
	 */
	Name: 3,
	/**
	 * `rslongue`, the establishment's name up to 60 characters.
	 */
	LongName: 4,
	/**
	 * `numvoie`.
	 */
	StreetNumber: 7,
	/**
	 * `typvoie`, a TRE-R35 code.
	 */
	StreetType: 8,
	/**
	 * `voie`.
	 */
	StreetName: 9,
	/**
	 * `compvoie`.
	 */
	RepetitionIndex: 10,
	/**
	 * `lieuditbp`.
	 */
	LieuDitOrBox: 11,
	/**
	 * `departement`.
	 */
	Departement: 13,
	/**
	 * `ligneacheminement`.
	 */
	RoutingLine: 15,
	/**
	 * `categetab`.
	 */
	Category: 18,
} as const

export type FinessColumn = (typeof FinessColumn)[keyof typeof FinessColumn]

/**
 * Why a line did not become a row.
 */
export const FinessRefusal = {
	/**
	 * The line is not a `structureet` record, as the comment on line 1 is not.
	 */
	NotEstablishment: "row:not-establishment",
	/**
	 * The establishment's `departement` is metropolitan.
	 */
	NotOverseas: "row:not-overseas",
	/**
	 * The establishment's category places people in a private dwelling.
	 */
	FamilyPlacement: "row:family-placement",
	/**
	 * The address is written care of a person.
	 */
	CareOfPerson: "row:care-of-person",
	/**
	 * The routing line is not a five-digit postcode followed by a locality and an optional `CEDEX`.
	 */
	RoutingLineUnparsed: "row:routing-line-unparsed",
	/**
	 * `typvoie` holds a code neither the codex nor TRE-R35's local transcription resolves.
	 */
	VoieTypeUnknown: "row:voie-type-unknown",
	/**
	 * `compvoie` is `C`, which the publisher's coding reads as quinquies and the data reads as a letter.
	 */
	RepetitionIndexAmbiguous: "row:repetition-index-ambiguous",
	/**
	 * A house number with no street name.
	 */
	NumberWithoutStreet: "row:number-without-street",
	/**
	 * A street type with no name after it.
	 */
	StreetNameAbsent: "row:street-name-absent",
	/**
	 * The street name holds a digit that does not name the street.
	 */
	StreetDigitUnplaced: "row:street-digit-unplaced",
	/**
	 * The lieu-dit holds a digit, as a floor, a building or a lot does and a place does not.
	 */
	LieuDitDigitUnplaced: "row:lieu-dit-digit-unplaced",
	/**
	 * The address gives a locality and a venue without a street, a lieu-dit or a box.
	 */
	DeliveryLineAbsent: "row:delivery-line-absent",
	/**
	 * The jurisdiction's layout does not print every component the row holds.
	 */
	Unrenderable: "row:unrenderable",
	/**
	 * Another establishment already produced this exact row.
	 */
	Duplicate: "row:duplicate",
} as const

export type FinessRefusal = (typeof FinessRefusal)[keyof typeof FinessRefusal]

/**
 * Why an admitted row left out a value the record holds.
 */
export const FinessTrim = {
	/**
	 * The lieu-dit line names part of a building or a landmark (`IMMEUBLE SEMAFA`), which is not a place.
	 */
	LieuDitPremiseDescriptor: "component:dependent_locality:premise-descriptor",
} as const

export type FinessTrim = (typeof FinessTrim)[keyof typeof FinessTrim]

/**
 * What one record yielded: a row with the values it left out, or the reason it yielded none.
 */
export type FinessReading =
	| { readonly admitted: CanonicalRow; readonly trimmed: readonly FinessTrim[] }
	| { readonly refused: FinessRefusal }

/**
 * The repetition indexes `compvoie` codes, written as the word an address prints.
 */
const REPETITION_INDEX: Readonly<Record<string, string>> = { B: "BIS", T: "TER", Q: "QUATER" }

/**
 * A line that opens with `Chez`, the care-of form.
 */
const CARE_OF_LINE = /^chez\b/iu

function cell(cells: readonly string[], column: FinessColumn): string {
	return (cells[column] ?? "").replaceAll(/\s+/gu, " ").trim()
}

/**
 * A street-type word written in the case of the name it precedes.
 */
function caseLike(word: string, name: string): string {
	if (word === word.toUpperCase()) return word

	if (!/\p{Ll}/u.test(name)) return word.toUpperCase()

	return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * The jurisdiction of an establishment, from its `departement` code and, under `9A`, its postcode.
 */
export function finessCountry(departement: string, postcode: string): string | null {
	const country = FINESS_COUNTRY_BY_DEPARTEMENT[departement]

	if (!country) return null

	if (departement === "9A") return FINESS_COUNTRY_BY_POSTCODE[postcode] ?? country

	return country
}

/**
 * The street components of one record, or the reason they cannot be read.
 */
function readStreet(
	cells: readonly string[]
): { street?: string; street_prefix?: string; house_number?: string } | { refused: FinessRefusal } {
	const name = cell(cells, FinessColumn.StreetName)
	const code = cell(cells, FinessColumn.StreetType).toUpperCase()
	const number = cell(cells, FinessColumn.StreetNumber).replace(/^0+(?=\d)/u, "")
	const index = cell(cells, FinessColumn.RepetitionIndex).toUpperCase()
	const hasNumber = /^\d+$/u.test(number) && number !== "0"

	if (!name) {
		if (hasNumber) return { refused: FinessRefusal.NumberWithoutStreet }

		if (code && code !== "LD") return { refused: FinessRefusal.StreetNameAbsent }

		return {}
	}

	if (!isStreetNameDigitPlaced(name)) return { refused: FinessRefusal.StreetDigitUnplaced }

	if (index && !REPETITION_INDEX[index]) return { refused: FinessRefusal.RepetitionIndexAmbiguous }

	const out: { street?: string; street_prefix?: string; house_number?: string } = {}

	if (hasNumber) {
		out.house_number = composeHouseNumber(number, index ? REPETITION_INDEX[index]! : "", " ")
	}

	const word = code ? expandFinessVoieType(code) : null

	if (word === undefined) return { refused: FinessRefusal.VoieTypeUnknown }

	// With no code, or a code that adds no word, the name holds whatever type word it has.
	if (word === null) {
		const split = splitFrenchStreetType(name)

		if (split?.street) {
			out.street_prefix = split.street_prefix
			out.street = split.street
		} else {
			out.street = name
		}

		return out
	}

	// A name that already opens with its own type word, or with the code, is not given the word twice.
	const [firstToken = "", ...rest] = name.split(" ")

	if (rest.length && (isSamePlace(firstToken, word) || isSamePlace(firstToken, code))) {
		out.street_prefix = firstToken
		out.street = rest.join(" ")

		return out
	}

	out.street_prefix = caseLike(word, name)
	out.street = name

	return out
}

/**
 * Read one CSV record into a row, or report why it yielded none.
 *
 * Exported because the refusal reasons are what this adapter is measured by: a caller reading the
 * whole extract counts them per reason rather than observing a row count it cannot account for.
 */
export function readFinessRecord(cells: readonly string[]): FinessReading {
	if (cell(cells, FinessColumn.Section) !== "structureet") return { refused: FinessRefusal.NotEstablishment }

	const departement = cell(cells, FinessColumn.Departement).toUpperCase()

	if (!FINESS_COUNTRY_BY_DEPARTEMENT[departement]) return { refused: FinessRefusal.NotOverseas }

	if (
		FINESS_FAMILY_PLACEMENT_CATEGORIES.has(cell(cells, FinessColumn.Category)) ||
		FAMILY_PLACEMENT_NAME.test(cell(cells, FinessColumn.Name)) ||
		FAMILY_PLACEMENT_NAME.test(cell(cells, FinessColumn.LongName))
	) {
		return { refused: FinessRefusal.FamilyPlacement }
	}

	const lieuDit = cell(cells, FinessColumn.LieuDitOrBox)
	const voie = cell(cells, FinessColumn.StreetName)

	if (
		cell(cells, FinessColumn.StreetType).toUpperCase() === CARE_OF_VOIE_TYPE ||
		CARE_OF_LINE.test(voie) ||
		CARE_OF_LINE.test(lieuDit)
	) {
		return { refused: FinessRefusal.CareOfPerson }
	}

	const routing = parseAcheminementLine(cell(cells, FinessColumn.RoutingLine))

	if (!routing) return { refused: FinessRefusal.RoutingLineUnparsed }

	const country = finessCountry(departement, routing.postcode)!
	const street = readStreet(cells)

	if ("refused" in street) return street

	const components: CanonicalRow["components"] = {}
	const trimmed: FinessTrim[] = []
	const venue = cell(cells, FinessColumn.LongName) || cell(cells, FinessColumn.Name)

	if (venue) {
		components.venue = venue
	}

	if (lieuDit) {
		const { poBox, remainder } = splitPostBox(lieuDit)

		if (poBox) {
			components.po_box = poBox
		}

		if (remainder && !isSamePlace(remainder, routing.locality) && !isSamePlace(remainder, voie)) {
			if (/\d/u.test(remainder)) return { refused: FinessRefusal.LieuDitDigitUnplaced }

			if (isPremiseDescriptor(remainder)) {
				trimmed.push(FinessTrim.LieuDitPremiseDescriptor)
			} else {
				components.dependent_locality = remainder
			}
		}
	}

	if (street.house_number) {
		components.house_number = street.house_number
	}

	if (street.street_prefix) {
		components.street_prefix = street.street_prefix
	}

	if (street.street) {
		components.street = street.street
	}

	if (!components.street && !components.po_box && !components.dependent_locality) {
		return { refused: FinessRefusal.DeliveryLineAbsent }
	}

	components.postcode = routing.postcode
	components.locality = routing.locality

	if (routing.cedex) {
		components.cedex = routing.cedex
	}

	const rendered = formatAddressRow(components, country, { singleLine: true })

	if (!rendered || rendered.unplaced.length) return { refused: FinessRefusal.Unrenderable }

	return {
		admitted: {
			raw: rendered.raw,
			components: rendered.components,
			country,
			locale: `fr-${country}`,
			source: FR_FINESS_ADAPTER_ID,
			source_id: stableSourceID(FR_FINESS_ADAPTER_ID, rendered.components),
			corpus_version: "",
			license: FR_FINESS_LICENSE,
		},
		trimmed,
	}
}

export function createFinessAdapter(): CorpusAdapter {
	return {
		id: FR_FINESS_ADAPTER_ID,
		defaultLicense: FR_FINESS_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.FINESS,
		surface: SurfaceOrigin.Rendered,
		description:
			"FINESS establishment extract: the addresses of health and social establishments in France's overseas jurisdictions.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !FR_FINESS_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(FR_FINESS_ADAPTER_ID, FR_FINESS_COUNTRIES, opts.country)
			}

			const records = CSVSpliterator.fromAsync<string[]>(await finessExtractPath(opts.inputPath), {
				mode: "array",
				header: false,
				columnDelimiter: ";",
			})

			const seen = new Set<string>()
			let emitted = 0

			for await (const cells of records) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const reading = readFinessRecord(cells)

				if (!("admitted" in reading)) {
					countDropped(opts, reading.refused)

					continue
				}

				// A caller naming one jurisdiction reads that jurisdiction's rows,
				// and the others are not refusals of the source.
				if (opts.country && reading.admitted.country !== opts.country) continue

				if (seen.has(reading.admitted.source_id)) {
					countDropped(opts, FinessRefusal.Duplicate)

					continue
				}

				for (const reason of reading.trimmed) {
					countDropped(opts, reason)
				}

				seen.add(reading.admitted.source_id)
				yield reading.admitted

				emitted++
			}
		},
	}
}

/**
 * The extract under `inputPath`, which is one `.csv` or the directory `fetchFinessOverseas` writes.
 *
 * A directory is read for its newest `etalab-cs1100502-stock-<date>-<time>.csv`, whose name sorts by date.
 * A directory holding none raises rather than yielding zero rows, so a wrong path
 * reports itself instead of reading as a register with no establishments.
 */
async function finessExtractPath(inputPath: PathBuilderLike): Promise<PathBuilderLike> {
	const path = PathBuilder.from(inputPath)

	if (path.basename().toLowerCase().endsWith(".csv")) return path

	const names = await Globerator.from("etalab-cs1100502-stock-*.csv", {
		cwd: path.toString(),
		absolute: false,
	}).toSorted()

	const newest = names.at(-1)

	if (!newest) {
		throw new Error(`${FR_FINESS_ADAPTER_ID} adapter: ${path.toString()} holds no etalab-cs1100502-stock-*.csv extract`)
	}

	return path(newest)
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const finessAdapter = createFinessAdapter()
