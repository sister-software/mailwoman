// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `nc-opt-agences`: the agencies of the Office des postes et télécommunications de
 * Nouvelle-Calédonie (OPT-NC), New Caledonia's postal operator.
 *
 * OPT-NC publishes the list as the dataset `localisation-des-agences-opt-nc`
 * on `data.gouv.nc`, whose records are served by its open-data GIS, the ArcGIS
 * FeatureServer `Agences_opendata` layer 0 (`Agences_et_Centres`).
 * `mailwoman corpus fetch nc-opt-agences` writes one GeoJSON feature per line,
 * with the service's field names in lower case.
 *
 * Each feature holds a type (`Agence`, `Annexe`, …), the agency's name (`KONE`), the label
 * the service shows for it (`Agence de KONE`), a street line, a postcode, a town and a point.
 *
 * ## The row
 *
 * The venue is the service's label (`TEXTE`), the form OPT-NC shows the public (`Agence de KONE`).
 * The address is the street line, postcode and town.
 *
 * A street line is read by `readAnnuaireLine`, the French line reader the Annuaire de
 * l'éducation adapter uses on New Caledonia's schools: `23 AVENUE DE KONIAMBO` is a number,
 * a street-type word and a name, and `QANONO - VILLAGE DE WE` holds no number
 * and no street-type word, so it is a place and becomes `dependent_locality`.
 *
 * ## License
 *
 * The dataset's record on `data.gouv.nc` names OPT-NC as publisher and states
 * `Licence Ouverte v2.0` (`https://www.etalab.gouv.fr/wp-content/uploads/2017/04/ETALAB-Licence-Ouverte-v2.0.pdf`).
 * Licence Ouverte 2.0 lets the reuser « l'adapter, la modifier, l'extraire et la transformer »,
 * subject to naming the source and the date of its last update.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { JSONSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { readAnnuaireLine } from "#fr/adapters/annuaire-education/adapter"
import { isSamePlace } from "#fr/adapters/finess/postal-lines"
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
export const NC_OPT_AGENCES_ADAPTER_ID = "nc-opt-agences"

/**
 * The license the publisher's dataset record states.
 */
export const NC_OPT_AGENCES_LICENSE = "Licence Ouverte 2.0"

/**
 * The credit Licence Ouverte 2.0 requires: the licensor's name, beside the date of the data's last update.
 */
export const NC_OPT_AGENCES_ATTRIBUTION =
	"Office des postes et télécommunications de Nouvelle-Calédonie (OPT-NC), Localisation des agences OPT-NC, via data.gouv.nc"

/**
 * The file the fetcher writes and the adapter reads, one GeoJSON feature per line.
 */
export const NC_OPT_AGENCES_FILENAME = "agences.geojsonl"

/**
 * The properties of one agency as the fetcher writes them: the service's fields in
 * lower case, a field the service left empty written as `null`.
 */
export interface OPTNCAgencyProperties {
	objectid: number
	id: number | null
	texte: string | null
	type: string | null
	nom: string | null
	adresse: string | null
	code_postal: string | null
	ville: string | null
	globalid: string | null
}

/**
 * One agency as the fetcher writes it.
 */
export interface OPTNCAgencyFeature {
	type: "Feature"
	geometry: { type: "Point"; coordinates: [longitude: number, latitude: number] } | null
	properties: OPTNCAgencyProperties
}

/**
 * Why a feature yielded no row.
 */
export const OPTNCRefusal = {
	IdentifierAbsent: "row:identifier-absent",
	NameAbsent: "row:name-absent",
	/**
	 * `code_postal` isn't New Caledonia's five digits beginning `988`.
	 */
	PostcodeAbsent: "row:postcode-absent",
	LocalityAbsent: "row:locality-absent",
	StreetLineAbsent: "row:street-line-absent",
	/**
	 * The street line holds a digit the line reader cannot place, or a street-type word with no name.
	 */
	StreetLineUnread: "row:street-line-unread",
	Unrenderable: "row:unrenderable",
} as const

export type OPTNCRefusal = (typeof OPTNCRefusal)[keyof typeof OPTNCRefusal]

/**
 * An agency's address as labeled components, or the reason it has none.
 */
export function readOPTNCAddress(
	properties: Pick<OPTNCAgencyProperties, "adresse" | "code_postal" | "ville">
): { readonly components: CanonicalRow["components"] } | { readonly refused: OPTNCRefusal } {
	const postcode = properties.code_postal?.trim() ?? ""
	const locality = properties.ville?.trim() ?? ""
	const line = properties.adresse?.replaceAll(/\s+/gu, " ").trim() ?? ""

	if (!/^988\d{2}$/u.test(postcode)) return { refused: OPTNCRefusal.PostcodeAbsent }

	if (!locality) return { refused: OPTNCRefusal.LocalityAbsent }

	if (!line) return { refused: OPTNCRefusal.StreetLineAbsent }

	const reading = readAnnuaireLine(line)
	const components: CanonicalRow["components"] = {}

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
			// A place line that only repeats the town would label the same words twice.
			if (isSamePlace(reading.place, locality)) return { refused: OPTNCRefusal.StreetLineAbsent }

			components.dependent_locality = reading.place
			break
		default:
			return { refused: OPTNCRefusal.StreetLineUnread }
	}

	return { components: { ...components, postcode, locality } }
}

/**
 * Read one feature into a corpus row, or report why it yielded none.
 */
export function readOPTNCAgency(feature: OPTNCAgencyFeature): { admitted: CanonicalRow } | { refused: OPTNCRefusal } {
	const { properties } = feature
	const id = properties.globalid ?? (properties.id == null ? null : String(properties.id))

	if (!id) return { refused: OPTNCRefusal.IdentifierAbsent }

	const name = properties.texte?.trim() || properties.nom?.trim()

	if (!name) return { refused: OPTNCRefusal.NameAbsent }

	const address = readOPTNCAddress(properties)

	if ("refused" in address) return address

	// `venue` first, so alignment claims its span before `locality` searches for its own.
	const rendered = formatAddressRow({ venue: name, ...address.components }, "NC", { singleLine: true })

	if (!rendered || rendered.unplaced.length) return { refused: OPTNCRefusal.Unrenderable }

	return {
		admitted: {
			raw: rendered.raw,
			components: rendered.components,
			country: "NC",
			locale: "fr-NC",
			source: NC_OPT_AGENCES_ADAPTER_ID,
			source_id: `${NC_OPT_AGENCES_ADAPTER_ID}-${id}`,
			license: NC_OPT_AGENCES_LICENSE,
		},
	}
}

export function createOPTNCAgencesAdapter(): CorpusAdapter {
	return {
		id: NC_OPT_AGENCES_ADAPTER_ID,
		defaultLicense: NC_OPT_AGENCES_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.OPTNCAgences,
		surface: SurfaceOrigin.Rendered,
		description: "OPT-NC's agencies (Licence Ouverte 2.0): New Caledonia's post offices beside their addresses.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "NC") {
				throw new UnsupportedCountryError(NC_OPT_AGENCES_ADAPTER_ID, ["NC"], opts.country)
			}

			let emitted = 0

			for await (const feature of JSONSpliterator.fromAsync<OPTNCAgencyFeature>(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const reading = readOPTNCAgency(feature)

				if ("refused" in reading) {
					countDropped(opts, reading.refused)

					continue
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
export const optNCAgencesAdapter = createOPTNCAgencesAdapter()
