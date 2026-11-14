// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `au-acnc-register`: the Australian Charities and Not-for-profits Commission's register of charities
 *   (`ACNC Registered Charities`, data.gov.au dataset `acnc-register`), read by the evaluation
 *   source and by the `au-acnc-register` corpus adapter through {@linkcode readACNCCharities}.
 *
 *   Each row is one registered charity with up to three address lines, a town, a state and a postcode.
 *   Every row's `Address_Type` reads `Business`.
 *
 *   A charity whose address the ACNC withholds has empty address columns and yields no record.
 *
 *   The rows read only the address, never the charity's name, because a small
 *   charity's name can be a person's.
 *   A record is kept only where its address is one street line with a house number,
 *   so a unit line or a post-office box line yields none.
 *
 *   ## License
 *
 *   The dataset record on data.gov.au (`package_show?id=acnc-register`), whose organization
 *   is `acnc`, states `license_title: Creative Commons Attribution 3.0 Australia`
 *   (`http://creativecommons.org/licenses/by/3.0/au/`), whose clause 3A grants the right to « create
 *   and Reproduce one or more Derivative Works » (`data/licenses/au-acnc-cc-by-3.0-au.md`).
 */

import type { PathBuilder, PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import {
	type EvaluationRecordReading,
	type EvaluationSource,
	evaluationSourceRead,
	evaluationStreetLine,
	fetchEvaluationFile,
	readEvaluationFetch,
} from "#evaluation/source"

/**
 * The register's CSV distribution on data.gov.au, updated weekly.
 */
export const AU_ACNC_REGISTER_URL =
	"https://data.gov.au/data/dataset/b050b242-4487-4306-abf5-07ca073e5594/resource/8fb32972-24e9-4c95-885e-7140be51be8a/download/datadotgov_main.csv"

/**
 * The file the fetch writes and the reader reads, under the publisher's own name.
 */
export const AU_ACNC_REGISTER_FILENAME = "datadotgov_main.csv"

/**
 * The eight states and territories, the values `State` takes on an Australian address.
 */
const STATES = new Set(["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"])

interface ACNCRow {
	abn?: string
	address_line_1?: string
	address_line_2?: string
	address_line_3?: string
	town_city?: string
	state?: string
	postcode?: string
	country?: string
}

function value(text: string | undefined): string {
	return (text ?? "").replaceAll(/\s+/gu, " ").trim()
}

/**
 * One register row as an address record, or the reason it yields none.
 */
export function readACNCCharity(row: ACNCRow): EvaluationRecordReading {
	const id = value(row.abn)
	const state = value(row.state)
	const postcode = value(row.postcode)
	const locality = value(row.town_city)
	const line = value(row.address_line_1)

	if (!id) return { refused: "row:identifier-absent" }

	if (!line) return { refused: "row:address-withheld" }

	if (value(row.country) && value(row.country).toLowerCase() !== "australia") return { refused: "row:overseas" }

	if (value(row.address_line_2) || value(row.address_line_3)) return { refused: "row:several-lines" }

	if (!STATES.has(state.toUpperCase())) return { refused: "row:state-absent" }

	if (!/^\d{4}$/u.test(postcode)) return { refused: "row:postcode-absent" }

	if (!locality) return { refused: "row:locality-absent" }

	if (/\b(?:p\.?\s?o\.?\s*box|gpo box|locked bag|private bag)\b/iu.test(line)) return { refused: "row:post-box" }

	const street = evaluationStreetLine(line, "AU")

	if ("refused" in street) return street

	return {
		id,
		stratum: state.toUpperCase(),
		components: {
			house_number: street.house_number,
			street: street.street,
			locality,
			region: state,
			postcode,
		},
	}
}

/**
 * Australia's evaluation source, the ACNC charity register.
 */
export const auACNCRegisterSource: EvaluationSource = {
	id: "au-acnc-register",
	country: "AU",
	publisher: "Australian Charities and Not-for-profits Commission",
	attribution:
		"Australian Charities and Not-for-profits Commission, ACNC Registered Charities, data.gov.au, CC BY 3.0 AU",
	license: "Creative Commons Attribution 3.0 Australia",
	registerSource: "au-charity-nonprofit-1",

	fetch: (directory, report) => fetchEvaluationFile(directory, AU_ACNC_REGISTER_URL, AU_ACNC_REGISTER_FILENAME, report),

	async read(directory: PathBuilder) {
		const fetched = await readEvaluationFetch(directory)

		return evaluationSourceRead(
			`fetched ${fetched.downloaded_at.slice(0, 10)}`,
			readACNCCharities(directory(AU_ACNC_REGISTER_FILENAME))
		)
	},
}

/**
 * Every row of the register CSV at `path`, read by {@linkcode readACNCCharity}.
 */
export async function* readACNCCharities(path: PathBuilderLike): AsyncGenerator<EvaluationRecordReading> {
	for await (const row of CSVSpliterator.fromAsync<ACNCRow>(path, { normalizeKeys: true })) {
		yield readACNCCharity(row)
	}
}
