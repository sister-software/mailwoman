// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   France's entry in the structures layer: La Poste's list of its points of contact
 *   (`laposte-poincont2` on `data.laposte.fr`), as `mailwoman corpus fetch fr-laposte-poincont` writes it.
 *
 *   Every bureau de poste, agence postale and relais poste is filed under the post-office category.
 *   A `Point partenaire`, a shop that hands over parcels, is no post office and yields no record.
 *
 *   The list is La Poste's own record of where it serves the public,
 *   so its provenance is the postal operator's.
 *   Licence Ouverte 2.0.
 */

import type { PathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import {
	FR_LAPOSTE_POINCONT_ADAPTER_ID,
	isLaPostePostOffice,
	LAPOSTE_POINCONT_FILENAME,
	laPosteNamesKeeper,
	laPosteSiteName,
	type LaPostePoincontRecord,
	readLaPosteAddress,
} from "#fr/adapters/laposte-poincont/adapter"
import { countryOfInseeCode } from "#fr/insee-country"
import type { LaPostePoincontManifest } from "#fr/tools/fetch/laposte-poincont"
import {
	postOfficeCategoryID,
	StructureProvenance,
	type StructureRecord,
	type StructureSource,
	type StructureSourceRead,
} from "#structures/source"
import { readManifest } from "#tools/fetch/download"

/**
 * One fetched row as a structure record, or `null` when it has no identifier or is a parcel partner.
 *
 * The address is read as the `fr-laposte-poincont` adapter reads it.
 */
export function laPosteStructureRecord(record: LaPostePoincontRecord, category: string): StructureRecord | null {
	const id = record.identifiant_a == null ? "" : String(record.identifiant_a).trim()

	if (!id || !isLaPostePostOffice(record)) return null

	const latitude = typeof record.latitude === "number" ? record.latitude : null
	const longitude = typeof record.longitude === "number" ? record.longitude : null
	const address = readLaPosteAddress(record)

	return {
		id,
		// A label beside a complement identifying the keeper may hold the keeper's surname.
		name: laPosteNamesKeeper(record) ? null : laPosteSiteName(record),
		category,
		point: latitude != null && longitude != null ? { latitude, longitude } : null,
		address: "components" in address ? address.components : null,
	}
}

/**
 * The records of one jurisdiction, read from its INSEE commune code.
 */
async function* records(path: PathBuilder, country: string): AsyncIterable<StructureRecord> {
	const category = postOfficeCategoryID()

	for await (const row of JSONSpliterator.fromAsync<LaPostePoincontRecord>(path.toString())) {
		if (countryOfInseeCode(row.code_insee == null ? "" : String(row.code_insee)) !== country) continue

		const record = laPosteStructureRecord(row, category)

		if (record) {
			yield record
		}
	}
}

const FETCH_COMMAND = "mailwoman corpus fetch fr-laposte-poincont"

/**
 * La Poste's points of contact in one jurisdiction.
 *
 * A source states one country for every row it contributes, and the file covers metropolitan France
 * and the overseas departments, so each jurisdiction is its own source over the same file.
 */
export function laPostePoincontStructures(country: string): StructureSource {
	return {
		id: country === "FR" ? "laposte-poincont" : `laposte-poincont-${country.toLowerCase()}`,
		country,
		publisher: "La Poste",
		attribution: "La Poste - Branche Réseau, Liste des bureaux de poste, agences postales et relais poste",
		license: "etalab-2.0",
		registerSource: "fr-postal-1",
		provenance: StructureProvenance.PostalOperator,
		fetchCommand: FETCH_COMMAND,

		async read(sourcesRoot): Promise<StructureSourceRead> {
			const directory = sourcesRoot(FR_LAPOSTE_POINCONT_ADAPTER_ID)
			const manifest = await readManifest<LaPostePoincontManifest>(directory("MANIFEST.json"))

			if (!manifest?.downloaded_at) {
				throw new Error(`${directory} holds no MANIFEST.json with a fetch date. Run \`${FETCH_COMMAND}\` first.`)
			}

			return {
				vintage: (manifest.publisher_version ?? manifest.downloaded_at).slice(0, 10),
				records: records(directory(LAPOSTE_POINCONT_FILENAME), country),
			}
		},
	}
}

/**
 * The jurisdictions La Poste's file holds sites in: metropolitan France and the overseas
 * departments and collectivities whose INSEE codes appear in it.
 *
 * French Polynesia, New Caledonia and Wallis and Futuna have their own postal operators and hold no row.
 */
export const LAPOSTE_POINCONT_COUNTRIES: readonly string[] = [
	// country-branch: the jurisdictions La Poste's own file serves.
	// The file's INSEE commune codes are the source.
	"FR",
	"GP",
	"MQ",
	"GF",
	"RE",
	"PM",
	"YT",
	"BL",
	"MF",
]

/**
 * One structure source per jurisdiction in {@linkcode LAPOSTE_POINCONT_COUNTRIES}.
 */
export const LAPOSTE_POINCONT_STRUCTURE_SOURCES: readonly StructureSource[] =
	LAPOSTE_POINCONT_COUNTRIES.map(laPostePoincontStructures)
