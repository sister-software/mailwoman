/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `fr-annuaire-education-overseas`: the schools, education offices and guidance centers of France's
 * overseas jurisdictions, read from the education ministry's Annuaire de l'éducation.
 *
 * Input is JSON Lines, one record per line, as the OpenDataSoft export of the dataset
 * `fr-en-annuaire-education` on `data.education.gouv.fr` serves it at
 * `/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/exports/jsonl`. The export keys each
 * record by the dataset's field names (`nom_etablissement`, `adresse_1`, `adresse_2`, `adresse_3`,
 * `code_postal`, `nom_commune`, `code_departement`, `etat`), and {@linkcode AnnuaireRecord} declares
 * the ones this adapter reads. `fetchAnnuaireEducationOverseas` asks the export for the overseas
 * departments only, and the adapter filters again, so a whole-country export reads the same.
 *
 * ## Which rows are read
 *
 * `code_departement` is the three-digit INSEE department: `971` to `976`, `977` Saint-Barthélemy,
 * `978` Saint-Martin, `986` Wallis-et-Futuna, `987` French Polynesia and `988` New Caledonia. The
 * jurisdiction is read through `COUNTRY_BY_INSEE_DEPARTMENT`, the table the BAN adapter uses. A
 * metropolitan row is refused under {@linkcode AnnuaireRefusal.NotOverseas}, and a row whose `etat`
 * is not `OUVERT` under {@linkcode AnnuaireRefusal.NotOpen}.
 *
 * ## Organizations only
 *
 * Every record is an education establishment or office. One private school among the overseas
 * records writes its address care of one person (`Chez …`), which places it at that person's
 * premises, so a line opening with `Chez` refuses the row under {@linkcode AnnuaireRefusal.CareOfPerson}.
 *
 * ## The three address lines
 *
 * `adresse_1` is the street line, `adresse_2` a complement, and `adresse_3` La Poste's routing line
 * when the publisher filled it. The publisher writes them as people typed them, so each is read by
 * what it holds rather than by its position:
 *
 * - **A street.** `5 rue Maréchal Leclerc` opens with a number and a street-type word, and
 *   `Rue Marcel Bonin` with the word only. The word becomes `street_prefix` through
 *   {@linkcode splitFrenchStreetType}, which reads the BAN reader's dictionary and then TRE-R35's
 *   street types for the words it lacks (`quartier`, `lotissement`, `ZAC`). A number of `0` is the
 *   publisher's placeholder for none. `Bourg` or `Village` written by itself refers to the
 *   settlement's center and is read as a place.
 * - **A district under a street.** A complement after a street line whose type word is not a
 *   thoroughfare (`Quartier d'Orléans`, `BOIS DE NEFLES`, `Plaine Adam`) refers to the district the
 *   street is in, and becomes `dependent_locality`.
 * - **A place.** `MATA UTU`, `Gustavia`, `ATOLL DE TAKAROA` hold no number and no street-type word.
 *   In these jurisdictions such a line gives the village, quarter or lieu-dit the school stands in,
 *   so it becomes `dependent_locality`. A leading `Lieu-dit` is dropped from it.
 * - **A building or a landmark.** `Lycée de Poindimié`, `ENCEINTE ECOLE DE TIAPA`, `PARKING MEGA`
 *   locate the school by another site and are left out of the row, counted under
 *   {@linkcode AnnuaireTrim.LinePremiseDescriptor}.
 * - **A box.** `BP 4238`, `FAAA / BP 509`, `BP M2` becomes `po_box`, and the rest of the line is
 *   read again as one of the shapes above.
 *
 * French Polynesia's complement line opens with the publisher's archipelago code (`IDV TAHITI`,
 * `ISLV RAIATEA`, `TG RANGIROA`, `MARQ UA POU`, `AUSTRALES RIMATARA`), which is an administrative
 * grouping rather than part of the address, so a remainder opening with one is left out and counted
 * under {@linkcode AnnuaireTrim.ArchipelagoCode}.
 *
 * A digit the reading above cannot place refuses the row: `PK 4 APOOITI UTUROA RAIATEA` is a
 * kilometer point, `TSOUNDZOU 2` and `ZUP 1` are numbered quarters this reader cannot tell from a
 * building number. A complement that writes the same place as the street line or the locality is
 * dropped, and a row left with two different place lines is refused under
 * {@linkcode AnnuaireRefusal.PlaceLinesConflict} rather than guessing which one is the lieu-dit.
 *
 * The postcode, locality and `cedex` come from `adresse_3` where it parses as a routing line, and
 * from `code_postal` and `nom_commune` otherwise. The codex layout of every jurisdiction here except
 * French Polynesia prints `cedex`, so a Polynesian `CEDEX` row is refused as unrenderable.
 *
 * ## Identity and license
 *
 * The row id is content-addressed over the aligned components, and a second record rendering the
 * same row is refused under {@linkcode AnnuaireRefusal.Duplicate}.
 *
 * The dataset's catalog record states `license` `Licence Ouverte v2.0 (Etalab)` with `license_url`
 * `http://www.etalab.gouv.fr/wp-content/uploads/2017/04/ETALAB-Licence-Ouverte-v2.0.pdf`, and gives
 * the publisher as `DNE - Ministère de l'Education Nationale`. That license states « Le « Réutilisateur
 * » est libre de réutiliser l'« Information » : […] de l'adapter, la modifier, l'extraire et la
 * transformer, pour créer des « Informations dérivées », des produits ou des services », « Sous
 * réserve de : mentionner la paternité de l'« Information » : sa source (au moins le nom du «
 * Concédant ») et la date de dernière mise à jour de l'« Information » réutilisée. » Every row
 * records the license, and {@linkcode FR_ANNUAIRE_EDUCATION_ATTRIBUTION} is the credit. The model
 * card completes it with the update date the fetch manifest records.
 *
 * The adapter honors `opts.limit`, `opts.signal` and `opts.country`, and counts every refusal
 * under its reason in `opts.dropped`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { foldToken } from "@mailwoman/codex/normalize"
import { JSONSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { isPremiseDescriptor, isSamePlace, parseAcheminementLine, splitPostBox } from "#fr/adapters/finess/postal-lines"
import { isStreetNameDigitPlaced, splitFrenchStreetType } from "#fr/adapters/finess/voie-type"
import { COUNTRY_BY_INSEE_DEPARTMENT } from "#fr/insee-country"
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
export const FR_ANNUAIRE_EDUCATION_ADAPTER_ID = "fr-annuaire-education-overseas"

/**
 * The license the dataset's catalog record states.
 */
export const FR_ANNUAIRE_EDUCATION_LICENSE = "Licence Ouverte 2.0"

/**
 * The credit Licence Ouverte 2.0 requires: the licensor's name, beside the date of the data's last update.
 */
export const FR_ANNUAIRE_EDUCATION_ATTRIBUTION =
	"Annuaire de l'éducation, DNE - Ministère de l'Education Nationale, via data.education.gouv.fr (fr-en-annuaire-education)"

/**
 * The overseas INSEE departments this adapter reads: every prefix in `COUNTRY_BY_INSEE_DEPARTMENT`
 * except `984`, the French Southern Territories, where there are no schools.
 */
export const FR_ANNUAIRE_EDUCATION_DEPARTEMENTS: readonly string[] = [
	"971",
	"972",
	"973",
	"974",
	"975",
	"976",
	"977",
	"978",
	"986",
	"987",
	"988",
]

/**
 * Every jurisdiction this adapter can emit.
 */
export const FR_ANNUAIRE_EDUCATION_COUNTRIES: readonly string[] = FR_ANNUAIRE_EDUCATION_DEPARTEMENTS.map(
	(code) => COUNTRY_BY_INSEE_DEPARTMENT[code]!
)

/**
 * The fields of one export record this adapter reads.
 *
 * The export writes `null` for an empty field.
 */
export interface AnnuaireRecord {
	identifiant_de_l_etablissement?: string | null
	nom_etablissement?: string | null
	adresse_1?: string | null
	adresse_2?: string | null
	adresse_3?: string | null
	code_postal?: string | null
	nom_commune?: string | null
	code_departement?: string | null
	etat?: string | null
}

/**
 * Why a record did not become a row.
 */
export const AnnuaireRefusal = {
	/**
	 * The record's department is metropolitan or not one this adapter reads.
	 */
	NotOverseas: "row:not-overseas",
	/**
	 * The establishment's `etat` is not `OUVERT`.
	 */
	NotOpen: "row:not-open",
	/**
	 * An address line is written care of a person.
	 */
	CareOfPerson: "row:care-of-person",
	/**
	 * Neither `adresse_3` nor `code_postal` gives a five-digit postcode.
	 */
	PostcodeAbsent: "row:postcode-absent",
	/**
	 * Neither `adresse_3` nor `nom_commune` gives a locality.
	 */
	LocalityAbsent: "row:locality-absent",
	/**
	 * A line holds a digit the reading cannot place as a house number, a box or a numbered street name.
	 */
	DigitUnplaced: "row:digit-unplaced",
	/**
	 * A street-type word with no name after it, as `0 route` is.
	 */
	StreetNameAbsent: "row:street-name-absent",
	/**
	 * The two lines give two different places, and the record does not mark either one as the lieu-dit.
	 */
	PlaceLinesConflict: "row:place-lines-conflict",
	/**
	 * The record gives a locality and a venue without a street, a place or a box.
	 */
	DeliveryLineAbsent: "row:delivery-line-absent",
	/**
	 * The jurisdiction's layout does not print every component the row holds.
	 */
	Unrenderable: "row:unrenderable",
	/**
	 * Another record already produced this exact row.
	 */
	Duplicate: "row:duplicate",
} as const

export type AnnuaireRefusal = (typeof AnnuaireRefusal)[keyof typeof AnnuaireRefusal]

/**
 * Why an admitted row left out a line the record holds.
 */
export const AnnuaireTrim = {
	/**
	 * A line locates a building or a landmark (`Lycée de Poindimié`) rather than a street or a place.
	 */
	LinePremiseDescriptor: "component:line:premise-descriptor",
	/**
	 * A complement opens with French Polynesia's archipelago code, an administrative grouping.
	 */
	ArchipelagoCode: "component:dependent_locality:archipelago-code",
} as const

export type AnnuaireTrim = (typeof AnnuaireTrim)[keyof typeof AnnuaireTrim]

/**
 * What one record yielded: a row with the lines it left out, or the reason it yielded none.
 */
export type AnnuaireReading =
	| { readonly admitted: CanonicalRow; readonly trimmed: readonly AnnuaireTrim[] }
	| { readonly refused: AnnuaireRefusal }

/**
 * The archipelago codes French Polynesia's complement lines open with: Îles du Vent,
 * Îles sous le Vent, Tuamotu-Gambier, Marquises and Australes.
 */
const ARCHIPELAGO_CODE = /^(?:idv|islv|tg|marq|australes)(?![\p{L}\d])/iu

/**
 * A leading house number, with a repetition index or letter suffix: `5`, `12 bis`, `5A`.
 */
const LEADING_NUMBER = /^(\d+)(?:\s*(bis|ter|quater)(?![\p{L}])|\s?([A-Za-z])(?![\p{L}'’]))?[\s,]+(.+)$/iu

/**
 * A leading `Lieu-dit` marker. A place line drops it.
 */
const LIEU_DIT_MARKER = /^lieu[- ]dit\s+/iu

/**
 * A line opening with `Chez`, the care-of form.
 */
const CARE_OF_LINE = /^chez(?![\p{L}\d])/iu

/**
 * Street-type words that name a way people travel along, as opposed to a district, an estate, a zone
 * or a landform (`quartier`, `ZAC`, `bois`, `plaine`) that the libpostal dictionary also lists.
 */
const THOROUGHFARE_WORDS: ReadonlySet<string> = new Set([
	"rue",
	"r",
	"avenue",
	"av",
	"boulevard",
	"bd",
	"chemin",
	"ch",
	"che",
	"route",
	"rte",
	"route nationale",
	"allee",
	"impasse",
	"imp",
	"place",
	"pl",
	"voie",
	"sentier",
	"ruelle",
	"passage",
	"quai",
	"cours",
	"square",
	"rocade",
	"traverse",
	"montee",
	"promenade",
	"esplanade",
	"rond-point",
])

/**
 * Street-type words that stand for a settlement's center: `Bourg`, `Village`.
 */
const LONE_PLACE_WORDS: ReadonlySet<string> = new Set(["bourg", "village", "le bourg"])

function isThoroughfareWord(word: string): boolean {
	return THOROUGHFARE_WORDS.has(foldToken(word).replace(/\.$/u, ""))
}

function field(value: string | null | undefined): string {
	return (value ?? "").replaceAll(/\s+/gu, " ").trim()
}

/**
 * One address line, read by what it holds.
 */
type LineReading =
	| { kind: "street"; street_prefix?: string; street: string; house_number?: string }
	| { kind: "place"; place: string }
	| { kind: "premise" }
	| { kind: "archipelago" }
	| { kind: "refused"; reason: AnnuaireRefusal }

/**
 * Read one address line, after any post-office box has been taken out of it.
 */
export function readAnnuaireLine(line: string): LineReading {
	const text = line.replace(LIEU_DIT_MARKER, "").trim()

	if (ARCHIPELAGO_CODE.test(text)) return { kind: "archipelago" }

	if (isPremiseDescriptor(text)) return { kind: "premise" }

	const numbered = LEADING_NUMBER.exec(text)
	const body = numbered ? numbered[4]!.trim() : text

	// The number as written, suffix included (`22 bis`, `5A`), and none for the publisher's `0`.
	const house =
		numbered && !/^0+$/u.test(numbered[1]!)
			? text
					.slice(0, text.length - numbered[4]!.length)
					.replace(/[\s,]+$/u, "")
					.replace(/^0+(?=\d)/u, "")
			: ""

	const split = splitFrenchStreetType(body)

	if (split) {
		if (!split.street) {
			// `Bourg` and `Village` on their own refer to the settlement's center. That center is a place.
			if (!house && split.street_prefix && LONE_PLACE_WORDS.has(foldToken(split.street_prefix))) {
				return { kind: "place", place: split.street_prefix }
			}

			return { kind: "refused", reason: AnnuaireRefusal.StreetNameAbsent }
		}

		if (!isStreetNameDigitPlaced(split.street) && !isStreetNameDigitPlaced(body)) {
			return { kind: "refused", reason: AnnuaireRefusal.DigitUnplaced }
		}

		return { kind: "street", ...split, ...(house ? { house_number: house } : {}) }
	}

	// A number before a word that is not a street type still opens a street line.
	if (numbered) {
		if (/\d/u.test(body)) return { kind: "refused", reason: AnnuaireRefusal.DigitUnplaced }

		return { kind: "street", street: body, ...(house ? { house_number: house } : {}) }
	}

	if (/\d/u.test(text)) return { kind: "refused", reason: AnnuaireRefusal.DigitUnplaced }

	return { kind: "place", place: text }
}

/**
 * Read one export record into a row, or report why it yielded none.
 *
 * Exported because the refusal reasons are what this adapter is measured by.
 */
export function readAnnuaireRecord(record: AnnuaireRecord): AnnuaireReading {
	const departement = field(record.code_departement)

	const country = FR_ANNUAIRE_EDUCATION_DEPARTEMENTS.includes(departement)
		? COUNTRY_BY_INSEE_DEPARTMENT[departement]
		: undefined

	if (!country) return { refused: AnnuaireRefusal.NotOverseas }

	if (field(record.etat).toUpperCase() !== "OUVERT") return { refused: AnnuaireRefusal.NotOpen }

	const line1 = field(record.adresse_1)
	const line2 = field(record.adresse_2)

	if (CARE_OF_LINE.test(line1) || CARE_OF_LINE.test(line2)) return { refused: AnnuaireRefusal.CareOfPerson }

	const routing = parseAcheminementLine(field(record.adresse_3))
	const postcode = routing?.postcode ?? field(record.code_postal)
	const locality = routing?.locality ?? field(record.nom_commune)

	if (!/^\d{5}$/u.test(postcode)) return { refused: AnnuaireRefusal.PostcodeAbsent }

	if (!locality) return { refused: AnnuaireRefusal.LocalityAbsent }

	const components: CanonicalRow["components"] = {}
	const trimmed: AnnuaireTrim[] = []
	const places: string[] = []
	const venue = field(record.nom_etablissement)

	if (venue) {
		components.venue = venue
	}

	for (const line of [line1, line2]) {
		if (!line) continue

		const { poBox, remainder } = splitPostBox(line)

		if (poBox && !components.po_box) {
			components.po_box = poBox
		}

		if (!remainder) continue

		const reading = readAnnuaireLine(remainder)

		switch (reading.kind) {
			case "refused":
				return { refused: reading.reason }
			case "premise":
				trimmed.push(AnnuaireTrim.LinePremiseDescriptor)
				break
			case "archipelago":
				trimmed.push(AnnuaireTrim.ArchipelagoCode)
				break
			case "street":
				if (components.street) {
					const written = `${reading.street_prefix ?? ""} ${reading.street}`.trim()

					// A complement under a street line that is not itself a thoroughfare gives the district the
					// street is in: `Quartier d'Orléans`, `ZAC de Moudong`, `BOIS DE NEFLES`, `Plaine Adam`.
					if (!reading.house_number && !isThoroughfareWord(reading.street_prefix ?? "")) {
						places.push(written)

						break
					}

					// The same holds the other way round: a district line followed by a thoroughfare.
					if (!components.house_number && !isThoroughfareWord(components.street_prefix ?? "")) {
						places.push(`${components.street_prefix ?? ""} ${components.street}`.trim())
						delete components.street_prefix
						components.street = reading.street

						if (reading.street_prefix) {
							components.street_prefix = reading.street_prefix
						}

						if (reading.house_number) {
							components.house_number = reading.house_number
						}

						break
					}

					if (!isSamePlace(written, `${components.street_prefix ?? ""} ${components.street}`)) {
						return { refused: AnnuaireRefusal.PlaceLinesConflict }
					}

					break
				}

				if (reading.house_number) {
					components.house_number = reading.house_number
				}

				if (reading.street_prefix) {
					components.street_prefix = reading.street_prefix
				}

				components.street = reading.street
				break
			case "place":
				if (isSamePlace(reading.place, locality) || isSamePlace(reading.place, field(record.nom_commune))) break

				if (places.some((place) => isSamePlace(place, reading.place))) break

				places.push(reading.place)
				break
		}
	}

	// A complement that repeats the street's name (`1 rue aloe vera` over `ALOE VERA`) adds no place.
	const distinctPlaces = places.filter(
		(place) =>
			!components.street ||
			(!isSamePlace(place, components.street) &&
				!isSamePlace(place, `${components.street_prefix ?? ""} ${components.street}`))
	)

	if (distinctPlaces.length > 1) return { refused: AnnuaireRefusal.PlaceLinesConflict }

	if (distinctPlaces[0]) {
		components.dependent_locality = distinctPlaces[0]
	}

	if (!components.street && !components.po_box && !components.dependent_locality) {
		return { refused: AnnuaireRefusal.DeliveryLineAbsent }
	}

	components.postcode = postcode
	components.locality = locality

	if (routing?.cedex) {
		components.cedex = routing.cedex
	}

	const rendered = formatAddressRow(components, country, { singleLine: true })

	if (!rendered || rendered.unplaced.length) return { refused: AnnuaireRefusal.Unrenderable }

	return {
		admitted: {
			raw: rendered.raw,
			components: rendered.components,
			country,
			locale: `fr-${country}`,
			source: FR_ANNUAIRE_EDUCATION_ADAPTER_ID,
			source_id: stableSourceID(FR_ANNUAIRE_EDUCATION_ADAPTER_ID, rendered.components),
			corpus_version: "",
			license: FR_ANNUAIRE_EDUCATION_LICENSE,
		},
		trimmed,
	}
}

export function createAnnuaireEducationAdapter(): CorpusAdapter {
	return {
		id: FR_ANNUAIRE_EDUCATION_ADAPTER_ID,
		defaultLicense: FR_ANNUAIRE_EDUCATION_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.AnnuaireEducation,
		surface: SurfaceOrigin.Rendered,
		description:
			"Annuaire de l'éducation: the addresses of schools and education offices in France's overseas jurisdictions.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !FR_ANNUAIRE_EDUCATION_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(
					FR_ANNUAIRE_EDUCATION_ADAPTER_ID,
					FR_ANNUAIRE_EDUCATION_COUNTRIES,
					opts.country
				)
			}

			const seen = new Set<string>()
			let emitted = 0

			for await (const record of JSONSpliterator.fromAsync<AnnuaireRecord>(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const reading = readAnnuaireRecord(record)

				if (!("admitted" in reading)) {
					countDropped(opts, reading.refused)

					continue
				}

				// A caller naming one jurisdiction reads that jurisdiction's rows,
				// and the others are not refusals of the source.
				if (opts.country && reading.admitted.country !== opts.country) continue

				if (seen.has(reading.admitted.source_id)) {
					countDropped(opts, AnnuaireRefusal.Duplicate)

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
 * The configured adapter instance registered with the corpus builder.
 */
export const annuaireEducationAdapter = createAnnuaireEducationAdapter()
