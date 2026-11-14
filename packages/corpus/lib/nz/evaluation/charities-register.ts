// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `nz-charities-register`: the Charities Register that Charities Services
 *   (Te Tari Taiwhenua, the Department of Internal Affairs) publishes through
 *   its OData service, an evaluation-only source.
 *
 *   The fetch asks `vOrganisations` for every registered charity's street address:
 *   two lines, a suburb, a city and a postcode.
 *   The second line can repeat the city or the city and postcode, and otherwise
 *   holds a rural delivery code (`RD 3`) or a second address.
 *
 *   A record is kept only where the second line is empty or repeats the city,
 *   and the first line is a street with a house number.
 *
 *   The rows read only the address, never the charity's name, because a small
 *   charity's name can be a person's.
 *
 *   The register states no region.
 *   NZ Post's postcodes run north to south by their first digit, so the record is stratified by that digit.
 *
 *   ## License
 *
 *   The open-data page (`https://www.charities.govt.nz/charities-in-new-zealand/the-charities-register/open-data`)
 *   states « Use of this data is licensed under a Creative Commons Attribution 3.0 New Zealand
 *   License. » CC BY 3.0 NZ grants the right to « create one or more Adaptations », provided
 *   each identifies that changes were made (`data/licenses/nz-charities-cc-by-3.0-nz.md`).
 */

import type { PathBuilder } from "path-ts"
import { CSVSpliterator } from "spliterator"

import {
	type EvaluationAddressRecord,
	type EvaluationSource,
	evaluationStreetLine,
	fetchEvaluationFile,
	readEvaluationFetch,
} from "#evaluation/source"

/**
 * The OData query: every registered charity's street address columns, as CSV, unpaged.
 */
export const NZ_CHARITIES_REGISTER_URL =
	"http://www.odata.charities.govt.nz/vOrganisations?$filter=RegistrationStatus%20eq%20%27Registered%27&$returnall=true" +
	"&$select=OrganisationId,CharityRegistrationNumber,StreetAddressLine1,StreetAddressLine2,StreetAddressSuburb," +
	"StreetAddressCity,StreetAddressPostcode,StreetAddressCountry&$format=csv"

/**
 * The file the fetch writes the query's CSV answer to and the reader reads.
 */
export const NZ_CHARITIES_REGISTER_FILENAME = "organisations.csv"

interface CharityRow {
	charity_registration_number?: string
	street_address_line1?: string
	street_address_line2?: string
	street_address_suburb?: string
	street_address_city?: string
	street_address_postcode?: string
	street_address_country?: string
}

function value(text: string | undefined): string {
	return (text ?? "").replaceAll(/\s+/gu, " ").trim()
}

const sameText = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" }) === 0

/**
 * One register row as an address record, or the reason it yields none.
 */
export function readNZCharity(row: CharityRow): EvaluationAddressRecord | { refused: string } {
	const id = value(row.charity_registration_number)
	const city = value(row.street_address_city)
	const suburb = value(row.street_address_suburb)
	const postcode = value(row.street_address_postcode)
	const line = value(row.street_address_line1)
	const second = value(row.street_address_line2)
	const country = value(row.street_address_country)

	if (!id) return { refused: "row:identifier-absent" }

	if (!line) return { refused: "row:address-absent" }

	if (country && !sameText(country, "New Zealand")) return { refused: "row:overseas" }

	if (!/^\d{4}$/u.test(postcode)) return { refused: "row:postcode-absent" }

	if (!city) return { refused: "row:locality-absent" }

	if (second && !sameText(second, city) && !sameText(second, `${city} ${postcode}`) && !sameText(second, suburb)) {
		return { refused: "row:several-lines" }
	}

	if (/\b(?:p\.?\s?o\.?\s*box|private bag)\b/iu.test(line)) return { refused: "row:post-box" }

	const street = evaluationStreetLine(line, "NZ")

	if ("refused" in street) return street

	return {
		id,
		stratum: `postcode ${postcode[0]}`,
		components: {
			house_number: street.house_number,
			street: street.street,
			...(suburb && !sameText(suburb, city) ? { dependent_locality: suburb } : {}),
			locality: city,
			postcode,
		},
	}
}

/**
 * New Zealand's evaluation-only source, the Charities Register.
 */
export const nzCharitiesRegisterSource: EvaluationSource = {
	id: "nz-charities-register",
	country: "NZ",
	publisher: "Charities Services, Department of Internal Affairs",
	attribution: "Charities Services (Department of Internal Affairs), Charities Register open data, CC BY 3.0 NZ",
	license: "Creative Commons Attribution 3.0 New Zealand",
	registerSource: "nz-charity-nonprofit-1",

	fetch: (directory, report) =>
		fetchEvaluationFile(directory, NZ_CHARITIES_REGISTER_URL, NZ_CHARITIES_REGISTER_FILENAME, report),

	async read(directory: PathBuilder) {
		const fetched = await readEvaluationFetch(directory)
		const refused: Record<string, number> = {}

		async function* records(): AsyncGenerator<EvaluationAddressRecord> {
			for await (const row of CSVSpliterator.fromAsync<CharityRow>(directory(NZ_CHARITIES_REGISTER_FILENAME), {
				normalizeKeys: true,
			})) {
				const read = readNZCharity(row)

				if ("refused" in read) {
					refused[read.refused] = (refused[read.refused] ?? 0) + 1

					continue
				}

				yield read
			}
		}

		return { vintage: `fetched ${fetched.downloaded_at.slice(0, 10)}`, records: records(), refused }
	},
}
