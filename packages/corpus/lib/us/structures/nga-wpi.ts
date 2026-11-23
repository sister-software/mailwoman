// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The World Port Index (NGA Pub. 150) in the structures layer, as `mailwoman corpus fetch nga-wpi` writes it.
 *
 *   The National Geospatial-Intelligence Agency publishes the index as one CSV, `UpdatedPub150.csv`,
 *   which its Maritime Safety Information portal calls the official version of the content and updates
 *   monthly. Each row is a port or shipping facility: its World Port Index number, its name, a
 *   country spelled as the US Government's GENC standard spells it, a point, and over a hundred characteristics.
 *   No row holds a street address, so every record's `address` is `null` and the layer serves the
 *   ports to retrieval by name and point only.
 *
 *   The list spans the world, so each record states its own country. The country column holds a
 *   GENC short name; {@linkcode wpiCountryCode} reads it through the codex's country lookup and,
 *   where that lookup holds no such name, through {@linkcode WPI_GENC_COUNTRY_NAMES}.
 *
 *   Every port is filed under the `seaport` category. NGA compiles the index from its own Sailing
 *   Directions and charts and from contributions it reviews, so its provenance is a mapping agency's.
 *
 *   Terms: NGA's Commercial Use Warning states `NGA claims no copyright or other intellectual property
 *   right in the nautical products posted on this website for public use`, and requires a disclaimer
 *   on any product that uses NGA's name or implies an association with it.
 *   `unchecked-access-free-us-national-geospatial-intelligence-agency-nga` records the decision.
 */

import { COUNTRY_LOOKUP } from "@mailwoman/codex/country/country"
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
import type { NGAWPIManifest } from "#us/tools/fetch/nga-wpi"

/**
 * The source directory the fetcher writes.
 */
export const NGA_WPI_SOURCE_ID = "nga-wpi"

/**
 * The file the fetcher writes, under the publisher's own name.
 */
export const NGA_WPI_FILENAME = "UpdatedPub150.csv"

/**
 * The columns this module reads, as `readCSVRecords` normalizes the publisher's
 * headers (`World Port Index Number` → `world_port_index_number`).
 */
export const NGA_WPI_COLUMNS = [
	"world_port_index_number",
	"main_port_name",
	"country_code",
	"latitude",
	"longitude",
] as const

/**
 * A World Port Index number as the CSV writes it, with or without a zero fraction.
 */
const WPI_NUMBER = /^(?<number>\d+)(?:\.0+)?$/u

/**
 * The `@mailwoman/poi-taxonomy` category every port is filed under.
 */
const SEAPORT_CATEGORY = "seaport"

/**
 * The GENC short country spellings that the codex's country lookup doesn't hold,
 * mapped to their ISO 3166-1 alpha-2 codes.
 *
 * GENC is the US Government's profile of ISO 3166, and it spells several countries its own way
 * (`Burma`, `Congo (Kinshasa)`) and names some territories ISO 3166 groups under one code:
 * Johnson Atoll, Midway and Wake Island are UM, and Svalbard is SJ.
 */
export const WPI_GENC_COUNTRY_NAMES: Readonly<Record<string, string>> = {
	"British Virgin Islands": "VG",
	Brunei: "BN",
	Burma: "MM",
	"Cabo Verde": "CV",
	"Caribbean Netherlands": "BQ",
	"Congo (Brazzaville)": "CG",
	"Congo (Kinshasa)": "CD",
	"Cote D'Ivoire": "CI",
	"Falkland Islands (Islas Malvinas)": "FK",
	"Federated States of Micronesia": "FM",
	Iran: "IR",
	"Johnson Atoll": "UM",
	Macau: "MO",
	"Midway Islands": "UM",
	"North Korea": "KP",
	Russia: "RU",
	"Saint Helena, Ascension, and Tristan da Cunha": "SH",
	"Saint Vincent and the Grenadines (Windward Islands)": "VC",
	"Sint Maarten": "SX",
	"South Georgia and South Sandwich Islands": "GS",
	"South Korea": "KR",
	Svalbard: "SJ",
	Syria: "SY",
	Taiwan: "TW",
	Tanzania: "TZ",
	"The Bahamas": "BS",
	"The Gambia": "GM",
	"U.S. Virgin Islands": "VI",
	Vietnam: "VN",
	"Wake Island": "UM",
}

/**
 * One CSV row, keyed by the normalized column names.
 */
export type NGAWPIRow = Readonly<Record<string, string | undefined>>

/**
 * The ISO 3166-1 alpha-2 code of a row's GENC country name.
 *
 * @throws When neither the codex's country lookup nor {@linkcode WPI_GENC_COUNTRY_NAMES}
 * holds the name, so a port is never stamped with a guessed country.
 */
export function wpiCountryCode(name: string): string {
	const trimmed = name.trim()
	const code = COUNTRY_LOOKUP.get(trimmed.toLowerCase()) ?? WPI_GENC_COUNTRY_NAMES[trimmed]

	if (!code) {
		throw new Error(
			`the World Port Index names the country ${stringifyJSON(trimmed)}, which neither the codex's country ` +
				`lookup nor WPI_GENC_COUNTRY_NAMES holds`
		)
	}

	return code
}

/**
 * One CSV row as a structure record.
 *
 * @throws When the row has no World Port Index number or its country can't be read.
 */
export function wpiStructureRecord(row: NGAWPIRow): StructureRecord {
	// The CSV writes every number as a float (`8225.0`); NGA's Sailing Directions cite it as `8225`.
	const id = WPI_NUMBER.exec(row["world_port_index_number"]?.trim() ?? "")?.groups?.["number"]

	if (!id) {
		throw new Error(`a World Port Index row has no whole port number: ${stringifyJSON(row).slice(0, 200)}`)
	}

	const latitude = Number(row["latitude"])
	const longitude = Number(row["longitude"])

	return {
		id,
		name: row["main_port_name"]?.trim() || null,
		category: SEAPORT_CATEGORY,
		point:
			row["latitude"]?.trim() && row["longitude"]?.trim() && Number.isFinite(latitude) && Number.isFinite(longitude)
				? { latitude, longitude }
				: null,
		address: null,
		country: wpiCountryCode(row["country_code"] ?? ""),
	}
}

async function* records(path: PathBuilder): AsyncIterable<StructureRecord> {
	for await (const row of readCSVRecords(path)) {
		yield wpiStructureRecord(row as NGAWPIRow)
	}
}

const FETCH_COMMAND = "mailwoman corpus fetch nga-wpi"

/**
 * NGA's World Port Index.
 */
export const ngaWorldPortIndexStructures: StructureSource = {
	id: "nga-world-port-index",
	country: "US",
	publisher: "National Geospatial-Intelligence Agency (NGA)",
	attribution:
		"World Port Index (Pub. 150), National Geospatial-Intelligence Agency. This reproduction, partial or " +
		"complete, of any National Geospatial-Intelligence Agency (NGA) product, information or data is not approved, " +
		"authorized or endorsed by the Secretary of Defense, the Director of National Intelligence, the Director, NGA or " +
		"any other element of the US Government.",
	license: "LicenseRef-USGov-Public-Domain",
	registerSource: "us-transport-2",
	provenance: StructureProvenance.MappingAgency,
	fetchCommand: FETCH_COMMAND,

	async read(sourcesRoot): Promise<StructureSourceRead> {
		const directory = sourcesRoot(NGA_WPI_SOURCE_ID)
		const manifest = await readManifest<NGAWPIManifest>(directory("MANIFEST.json"))

		if (!manifest?.downloaded_at) {
			throw new Error(`${directory} holds no MANIFEST.json with a fetch date. Run \`${FETCH_COMMAND}\` first.`)
		}

		return {
			vintage: (manifest.publisher_version ?? manifest.downloaded_at).slice(0, 10),
			records: records(directory(NGA_WPI_FILENAME)),
		}
	},
}
