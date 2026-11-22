// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { dataRootPath } from "@mailwoman/core/data-root"
import {
	findGeonamesPostalExport,
	GEONAMES_POSTAL_EXPORT_COLUMNS,
	geonamesPostalExportPaths,
	geonamesPostcodeKey,
	readGeonamesPostalExport,
} from "@mailwoman/gazetteer/tools/pipeline/postcode/geonames/export"
import { candidateSystemsForPostcode, SYSTEM_CODES } from "@mailwoman/postcode/systems"
import { resolvePath } from "path-ts"

/**
 * Looks up a complete postcode in the local exports of every matching address system.
 *
 * Each source is read to completion so all matching administrative associations are returned.
 */
export async function lookupPostcodeRegions(postcode: string, dataRoot: string = dataRootPath().toString()) {
	const key = geonamesPostcodeKey(postcode)

	if (!key) throw new Error("A postcode is required.")
	const candidates = candidateSystemsForPostcode(key)
	const results = []

	for (const system of candidates) {
		const country = system.toUpperCase()
		const directory = resolvePath(dataRoot, "geonames-postal")
		const artifact = await findGeonamesPostalExport(directory, country)

		if (!artifact) {
			const { text, zip } = geonamesPostalExportPaths(directory, country)

			throw new Error(`Cannot look up ${country}: neither ${text} nor ${zip} exists.`)
		}

		const raw: string[][] = []
		let rowsRead = 0

		for await (const columns of readGeonamesPostalExport(artifact, country)) {
			rowsRead++

			if (geonamesPostcodeKey(columns[1]!) === key) {
				raw.push(columns)
			}
		}

		results.push({ country, artifact, rows_read: rowsRead, matching_rows: raw.length, raw })
	}

	return {
		postcode,
		lookup_key: key,
		comparison: "trimmed, case-insensitive equality of the complete postcode",
		systems_checked: SYSTEM_CODES,
		candidate_systems: candidates,
		raw_columns: GEONAMES_POSTAL_EXPORT_COLUMNS,
		sources: results,
		table: results.flatMap(({ country, raw }) => [
			...raw.map((columns) => ({
				country,
				status: "matched",
				postcode: columns[1]!,
				place: columns[2]!,
				admin1: { name: columns[3]!, code: columns[4]! },
				admin2: { name: columns[5]!, code: columns[6]! },
				admin3: { name: columns[7]!, code: columns[8]! },
			})),
			...(raw.length
				? []
				: [{ country, status: "no_record", postcode: key, place: null, admin1: null, admin2: null, admin3: null }]),
		]),
		notes: [
			"Format candidates cover the supported address systems listed in systems_checked.",
			"Administrative fields report source associations. They do not establish polygon containment.",
			"Administrative codes are source codes. This export supplies no WOF IDs.",
			"A no_record result means the complete export has no matching postcode. Missing or unreadable exports raise an error.",
		],
	}
}
