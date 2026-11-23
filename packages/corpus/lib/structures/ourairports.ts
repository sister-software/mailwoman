// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   OurAirports' airports in the structures layer, as `mailwoman corpus fetch ourairports` writes them.
 *
 *   `airports.csv` lists airports, heliports, seaplane bases, balloon ports and closed sites worldwide.
 *   Each row holds an ident, a type, a name, a point in degrees, an `iso_country` code,
 *   a region and a municipality, and the IATA, ICAO, GPS and local codes.
 *
 *   No row holds a street address, so every record's `address` is `null`
 *   and the layer serves the airports to retrieval by name and point.
 *
 *   {@linkcode OURAIRPORTS_TYPE_CATEGORIES} files each open type under its
 *   `@mailwoman/poi-taxonomy` category.
 *   A `closed` site is no airport any longer, so it yields no record.
 *
 *   A type the table lacks fails the read, so a new type is never filed under a guessed category.
 *
 *   The list spans the world, so each record states its own country:
 *   the `iso_country` code when it is one the codex holds.
 *   OurAirports also uses codes ISO 3166-1 doesn't assign, such as `XK`, and a row under
 *   one of them yields no record, so no airport is stamped with a guessed country.
 *
 *   Volunteers edit OurAirports, so its provenance is a community's.
 *
 *   Terms: "All data is released to the Public Domain" (https://ourairports.com/data/).
 *   `unchecked-access-free-ca-ourairports` records the decision.
 */

import { ISO2_TO_NAME } from "@mailwoman/codex/country/country"
import { isoDate } from "@mailwoman/core/utils"
import { stringifyJSON } from "@mailwoman/core/values/json"
import type { PathBuilder } from "path-ts"

import { readCSVRecords } from "#recipes/scaffold"
import {
	StructureProvenance,
	type StructureRecord,
	type StructureSource,
	type StructureSourceRead,
} from "#structures/source"
import { readManifest } from "#tools/fetch/download"
import { OURAIRPORTS_SOURCE_ID, type OurAirportsManifest } from "#tools/fetch/ourairports"

/**
 * The file this module reads.
 */
const AIRPORTS_FILENAME = "airports.csv"

/**
 * The `type` of a site that no longer operates.
 */
const CLOSED_TYPE = "closed"

/**
 * The `@mailwoman/poi-taxonomy` category of each open OurAirports `type`.
 */
export const OURAIRPORTS_TYPE_CATEGORIES: Readonly<Record<string, string>> = {
	large_airport: "airport",
	medium_airport: "airport",
	small_airport: "airport",
	heliport: "heliports",
	seaplane_base: "seaplane_bases",
	balloonport: "balloon_ports",
}

/**
 * One CSV row, keyed by the publisher's column names.
 */
export type OurAirportsRow = Readonly<Record<string, string | undefined>>

/**
 * One CSV row as a structure record, or `null` for a closed site or a country
 * code ISO 3166-1 doesn't assign.
 *
 * @throws When the row has no ident, or a type {@linkcode OURAIRPORTS_TYPE_CATEGORIES} lacks.
 */
export function ourAirportsStructureRecord(row: OurAirportsRow): StructureRecord | null {
	const id = row["ident"]?.trim()

	if (!id) throw new Error(`an OurAirports row has no ident: ${stringifyJSON(row).slice(0, 200)}`)

	const type = row["type"]?.trim() ?? ""

	if (type === CLOSED_TYPE) return null

	const category = OURAIRPORTS_TYPE_CATEGORIES[type]

	if (!category) {
		throw new Error(
			`OurAirports row ${id} has the type ${stringifyJSON(type)}, which OURAIRPORTS_TYPE_CATEGORIES lacks`
		)
	}

	const country = row["iso_country"]?.trim() ?? ""

	if (!ISO2_TO_NAME.has(country)) return null

	const latitude = Number(row["latitude_deg"])
	const longitude = Number(row["longitude_deg"])

	return {
		id,
		name: row["name"]?.trim() || null,
		category,
		point:
			row["latitude_deg"]?.trim() &&
			row["longitude_deg"]?.trim() &&
			Number.isFinite(latitude) &&
			Number.isFinite(longitude)
				? { latitude, longitude }
				: null,
		address: null,
		country,
	}
}

async function* records(path: PathBuilder): AsyncIterable<StructureRecord> {
	for await (const row of readCSVRecords(path)) {
		const record = ourAirportsStructureRecord(row as OurAirportsRow)

		if (record) {
			yield record
		}
	}
}

const FETCH_COMMAND = "mailwoman corpus fetch ourairports"

/**
 * OurAirports' airports, heliports, seaplane bases and balloon ports.
 */
export const ourAirportsStructures: StructureSource = {
	id: "ourairports",
	country: "CA",
	publisher: "OurAirports",
	attribution: "OurAirports (https://ourairports.com/), released to the public domain",
	license: "LicenseRef-OurAirports-Public-Domain",
	registerSource: "ca-transport-1",
	provenance: StructureProvenance.Community,
	fetchCommand: FETCH_COMMAND,

	async read(sourcesRoot): Promise<StructureSourceRead> {
		const directory = sourcesRoot(OURAIRPORTS_SOURCE_ID)
		const manifest = await readManifest<OurAirportsManifest>(directory("MANIFEST.json"))
		const airports = manifest?.files.find((file) => file.filename === AIRPORTS_FILENAME)

		if (!manifest?.downloaded_at || !airports) {
			throw new Error(
				`${directory} holds no MANIFEST.json recording ${AIRPORTS_FILENAME}. Run \`${FETCH_COMMAND}\` first.`
			)
		}

		return {
			vintage: isoDate(new Date(airports.last_modified ?? manifest.downloaded_at)),
			records: records(directory(AIRPORTS_FILENAME)),
		}
	},
}
