// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `fr-laposte-poincont`: La Poste's list of its points of contact, the dataset `laposte-poincont2`
 * (« Liste des bureaux de poste, agences postales et relais poste ») on `data.laposte.fr`.
 *
 * `mailwoman corpus fetch fr-laposte-poincont` writes one row per line with the fields in
 * {@linkcode LAPOSTE_POINCONT_FIELDS}: the site's identifier, La Poste's label for it,
 * its type, a street line, a complement, a lieu-dit, the postcode, the locality,
 * the INSEE commune code, the country and a point.
 *
 * ## Which rows are read
 *
 * The 2026-11-08 file holds 19,858 sites in seven types: `Agence postale communale`,
 * `Bureau de Poste`, `Relais poste`, `Point partenaire`, `Agence postale intercommunale`,
 * `Agence postale ou Relais poste` and `Agence postale`.
 * Every type trains, because each row is a public counter's label beside its address.
 * {@linkcode isLaPostePostOffice} decides which of them the structures layer files as post offices.
 *
 * The jurisdiction is read from the INSEE commune code through `countryOfInseeCode`, so a site
 * in an overseas department is stamped with that department's code (`RE`, `GP`, `MQ`, …).
 * The seven Andorran sites (`pays` `ANDORRE`, postcodes `AD100`–`AD600`) are refused under
 * {@linkcode LaPosteRefusal.NotFrance}: Andorra's codex layout and street shapes are not French.
 *
 * ## The venue
 *
 * The label is La Poste's name for the site followed by a code for its type
 * (`AMBERIEU EN DOMBES BP`, `ANGLEFORT THE LIXIR RP`, `BEAUREGARD MAIRIE AP`, `NANTERRE E.LECLERC LPP`).
 * No address writer prints the trailing code. {@linkcode laPosteSiteName} drops it
 * and keeps the rest as the publisher wrote it.
 *
 * `venue` is inserted first so alignment claims its span before `locality` searches for its own.
 *
 * ## The address
 *
 * `adresse` is read by `readAnnuaireLine`, the French line reader the Annuaire de
 * l'éducation adapter uses: a house number, a street-type word and a name, or a place.
 * `lieu_dit` is the former commune or hamlet inside a merged commune
 * (`CHAVANNES SUR SURAN` in `NIVIGNE ET SURAN`) and becomes `dependent_locality`
 * when it differs from the locality.
 *
 * `complement_d_adresse` mixes a host shop's trading name (`TABAC GUDIN MIREILLE`), a building
 * (`MAIRIE`, `CITE ADMINISTRATIVE`) and a district (`ZAC DE MOUSQUETTE`), and a few name a person.
 * No reading tells these apart, so the line is left out of every row
 * and counted under {@linkcode LaPosteTrim.Complement}.
 *
 * ## People in the labels
 *
 * A relais poste or partner point is a shop, and its label can be the shop's trading name.
 * For a sole trader that name can be the keeper's surname
 * (`BRENOD GUDIN BURALISTE`, complement `TABAC GUDIN MIREILLE`).
 *
 * The label is the name the shop trades under, so it is read as a venue.
 *
 * A complement that opens with an honorific (`MME CHAMBARD`) identifies the keeper rather than the
 * shop. 20 relais rows of the 2026-11-08 file do, and the label `MANZIAT CHAMBARD BURALISTE RP`
 * holds that surname. {@linkcode laPosteNamesKeeper} finds them, and each is refused under
 * {@linkcode LaPosteRefusal.KeeperNamed} and filed in the structures layer without its label.
 * A keeper's surname in a label whose complement holds no honorific passes.
 * This passing surname is the residual exposure.
 *
 * ## License
 *
 * The publisher's dataset record states `license` `Licence Ouverte / Open Licence`
 * (`https://www.etalab.gouv.fr/licence-ouverte-open-licence`), owner `La poste`,
 * origin `La Poste - Branche Réseau`.
 * Licence Ouverte 2.0 lets the reuser « l'adapter, la modifier, l'extraire et la transformer », subject
 * to naming the source and the date of its last update. {@linkcode FR_LAPOSTE_POINCONT_ATTRIBUTION}
 * states the source, and the fetch manifest records the update date.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { JSONSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { readAnnuaireLine } from "#fr/adapters/annuaire-education/adapter"
import { isSamePlace } from "#fr/adapters/finess/postal-lines"
import { countryOfInseeCode, INSEE_COUNTRIES } from "#fr/insee-country"
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
 * Registry id for this adapter, and the source directory its fetcher writes.
 */
export const FR_LAPOSTE_POINCONT_ADAPTER_ID = "fr-laposte-poincont"

/**
 * The license the publisher's dataset record states.
 */
export const FR_LAPOSTE_POINCONT_LICENSE = "Licence Ouverte 2.0"

/**
 * The credit Licence Ouverte 2.0 requires: the licensor's name, beside the date of the data's last update.
 */
export const FR_LAPOSTE_POINCONT_ATTRIBUTION =
	"La Poste - Branche Réseau, Liste des bureaux de poste, agences postales et relais poste (laposte-poincont2), via data.laposte.fr"

/**
 * The file the fetcher writes and the adapter reads, one row per line.
 */
export const LAPOSTE_POINCONT_FILENAME = "laposte-poincont2.jsonl"

/**
 * The dataset fields the fetcher keeps, in the publisher's spelling.
 */
export const LAPOSTE_POINCONT_FIELDS = [
	"identifiant_a",
	"libelle_du_site",
	"caracteristique_du_site",
	"adresse",
	"complement_d_adresse",
	"lieu_dit",
	"code_postal",
	"localite",
	"code_insee",
	"pays",
	"latitude",
	"longitude",
	"precision_du_geocodage",
] as const

/**
 * One row as the fetcher writes it.
 * A field the publisher left empty is `null`.
 */
export type LaPostePoincontRecord = Readonly<
	Partial<Record<(typeof LAPOSTE_POINCONT_FIELDS)[number], string | number | null>>
>

/**
 * Why a row yielded no corpus row.
 */
export const LaPosteRefusal = {
	/**
	 * The site is outside France (`pays` isn't `FRANCE`).
	 */
	NotFrance: "row:not-france",
	/**
	 * The row has no identifier.
	 */
	IdentifierAbsent: "row:identifier-absent",
	/**
	 * The label is empty once its type code is dropped.
	 */
	NameAbsent: "row:name-absent",
	/**
	 * `code_postal` isn't five digits.
	 */
	PostcodeAbsent: "row:postcode-absent",
	LocalityAbsent: "row:locality-absent",
	/**
	 * `adresse` is empty.
	 */
	StreetLineAbsent: "row:street-line-absent",
	/**
	 * `adresse` holds a digit the line reader cannot place, or a street-type word with no name.
	 */
	StreetLineUnread: "row:street-line-unread",
	/**
	 * The complement identifies the site's keeper by an honorific (`MME CHAMBARD`).
	 */
	KeeperNamed: "row:keeper-named",
	/**
	 * The jurisdiction's layout doesn't print every component the row holds.
	 */
	Unrenderable: "row:unrenderable",
} as const

export type LaPosteRefusal = (typeof LaPosteRefusal)[keyof typeof LaPosteRefusal]

/**
 * Why an admitted row left out a field the record holds.
 */
export const LaPosteTrim = {
	/**
	 * `complement_d_adresse` was left out.
	 */
	Complement: "component:complement:unread",
} as const

/**
 * The type codes La Poste appends to a site's label: bureau de poste, agence postale,
 * relais poste, La Poste Partenaire (and its `LPPS` variant), and the express parcel points.
 */
const LABEL_TYPE_CODE = /\s+(?:BP|AP|RP|LPPS?|EXP)$/u

/**
 * The site types a post office is: every type but `Point partenaire`, a shop that hands over parcels.
 */
const POST_OFFICE_TYPE = /^(?:bureau de poste|agence postale|relais poste)/iu

function text(value: string | number | null | undefined): string {
	return value == null ? "" : String(value).replaceAll(/\s+/gu, " ").trim()
}

/**
 * The site's name: its label without the trailing type code, or `null` when the label held only the code.
 */
export function laPosteSiteName(record: Pick<LaPostePoincontRecord, "libelle_du_site">): string | null {
	return text(record.libelle_du_site).replace(LABEL_TYPE_CODE, "").trim() || null
}

/**
 * A complement opening with an honorific: `MME CHAMBARD`, `M. DUPONT`, `MONSIEUR …`.
 */
const HONORIFIC = /^(?:MME|MLLE|MR|M\.?|MONSIEUR|MADAME|MADEMOISELLE)\s+\S/iu

/**
 * Whether the row's complement identifies the site's keeper by an honorific.
 */
export function laPosteNamesKeeper(record: Pick<LaPostePoincontRecord, "complement_d_adresse">): boolean {
	return HONORIFIC.test(text(record.complement_d_adresse))
}

/**
 * Whether the site is a post office rather than a parcel partner.
 */
export function isLaPostePostOffice(record: Pick<LaPostePoincontRecord, "caracteristique_du_site">): boolean {
	return POST_OFFICE_TYPE.test(text(record.caracteristique_du_site))
}

/**
 * One row's address as labeled components with its jurisdiction, or the reason it has none.
 */
export function readLaPosteAddress(
	record: LaPostePoincontRecord
):
	| { readonly country: string; readonly components: CanonicalRow["components"] }
	| { readonly refused: LaPosteRefusal } {
	if (text(record.pays).toUpperCase() !== "FRANCE") return { refused: LaPosteRefusal.NotFrance }

	const postcode = text(record.code_postal)
	const locality = text(record.localite)
	const line = text(record.adresse)

	if (!/^\d{5}$/u.test(postcode)) return { refused: LaPosteRefusal.PostcodeAbsent }

	if (!locality) return { refused: LaPosteRefusal.LocalityAbsent }

	if (!line) return { refused: LaPosteRefusal.StreetLineAbsent }

	const reading = readAnnuaireLine(line)
	const components: CanonicalRow["components"] = {}
	const places: string[] = []

	switch (reading.kind) {
		case "street":
			if (reading.house_number) {
				components.house_number = reading.house_number
			}

			if (reading.street_prefix) {
				components.street_prefix = reading.street_prefix
			}

			components.street = reading.street
			break
		case "place":
			places.push(reading.place)
			break
		default:
			return { refused: LaPosteRefusal.StreetLineUnread }
	}

	const lieuDit = text(record.lieu_dit)

	if (lieuDit) {
		places.push(lieuDit)
	}

	// The first place that isn't the locality is the district.
	// A row with no street keeps its place line as the street.
	const place = places.find((candidate) => !isSamePlace(candidate, locality))

	if (place) {
		components.dependent_locality = place
	} else if (!components.street) {
		components.street = places[0]!
	}

	components.postcode = postcode
	components.locality = locality

	return { country: countryOfInseeCode(text(record.code_insee)), components }
}

/**
 * Read one row into a corpus row, or report why it yielded none.
 */
export function readLaPosteRecord(
	record: LaPostePoincontRecord
): { readonly admitted: CanonicalRow; readonly trimmed: boolean } | { readonly refused: LaPosteRefusal } {
	const id = text(record.identifiant_a)

	if (!id) return { refused: LaPosteRefusal.IdentifierAbsent }

	if (laPosteNamesKeeper(record)) return { refused: LaPosteRefusal.KeeperNamed }

	const address = readLaPosteAddress(record)

	if ("refused" in address) return address

	const name = laPosteSiteName(record)

	if (!name) return { refused: LaPosteRefusal.NameAbsent }

	// `venue` first, so alignment claims its span before `locality` searches for its own.
	const rendered = formatAddressRow({ venue: name, ...address.components }, address.country, { singleLine: true })

	if (!rendered || rendered.unplaced.length) return { refused: LaPosteRefusal.Unrenderable }

	return {
		admitted: {
			raw: rendered.raw,
			components: rendered.components,
			country: address.country,
			locale: `fr-${address.country}`,
			source: FR_LAPOSTE_POINCONT_ADAPTER_ID,
			source_id: `${FR_LAPOSTE_POINCONT_ADAPTER_ID}-${id}`,
			license: FR_LAPOSTE_POINCONT_LICENSE,
		},
		trimmed: Boolean(text(record.complement_d_adresse)),
	}
}

export function createLaPostePoincontAdapter(): CorpusAdapter {
	return {
		id: FR_LAPOSTE_POINCONT_ADAPTER_ID,
		defaultLicense: FR_LAPOSTE_POINCONT_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.LaPostePoincont,
		surface: SurfaceOrigin.Rendered,
		description:
			"La Poste's points of contact (Licence Ouverte 2.0): post offices, communal postal agencies, relais poste and partner points beside their addresses, in France and its overseas departments.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !INSEE_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(FR_LAPOSTE_POINCONT_ADAPTER_ID, INSEE_COUNTRIES, opts.country)
			}

			let emitted = 0

			for await (const record of JSONSpliterator.fromAsync<LaPostePoincontRecord>(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const reading = readLaPosteRecord(record)

				if ("refused" in reading) {
					countDropped(opts, reading.refused)

					continue
				}

				if (opts.country && reading.admitted.country !== opts.country) continue

				if (reading.trimmed) {
					countDropped(opts, LaPosteTrim.Complement)
				}

				yield reading.admitted

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const laPostePoincontAdapter = createLaPostePoincontAdapter()
