/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { candidateSystemsForPostcode, SYSTEM_CODES } from "@mailwoman/postcode/systems"
import { resolvePath } from "path-ts"
import { TSVSpliterator } from "spliterator"

/**
 * The columns preserved from each GeoNames postal export record, in source order.
 * Administrative codes belong to GeoNames and its sources.
 */
const POSTAL_COLUMNS = [
	"country",
	"postcode",
	"place",
	"admin1_name",
	"admin1_code",
	"admin2_name",
	"admin2_code",
	"admin3_name",
	"admin3_code",
	"latitude",
	"longitude",
	"accuracy",
] as const

/**
 * Looks up a complete postcode in the local exports of every matching address system.
 *
 * Each source is read to completion so all matching administrative associations are returned.
 */
export async function lookupPostcodeRegions(postcode: string, dataRoot: string = dataRootPath().toString()) {
	const key = postcode.trim().toUpperCase()

	if (!key) throw new Error("A postcode is required.")
	const candidates = candidateSystemsForPostcode(key)
	const results = []

	for (const system of candidates) {
		const country = system.toUpperCase()
		const text = resolvePath(dataRoot, "geonames-postal", `${country}.txt`)
		const zip = resolvePath(dataRoot, "geonames-postal", `${country}.zip`)
		let artifact: string
		let rows: AsyncIterable<string[]>

		if (await pathExists(text)) {
			artifact = text
			rows = readUnquotedTSV(text)
		} else if (await pathExists(zip)) {
			artifact = zip

			rows = TSVSpliterator.fromAsync(readZipEntry(zip, `${country}.txt`), {
				header: false,
				enableQuoteHandling: false,
			}) as AsyncIterable<string[]>
		} else {
			throw new Error(`Cannot look up ${country}: neither ${text} nor ${zip} exists.`)
		}

		const raw: string[][] = []
		let rowsRead = 0

		for await (const columns of rows) {
			rowsRead++

			if (columns.length !== POSTAL_COLUMNS.length || columns[0] !== country || !columns[1]) {
				throw new Error(`Invalid postal record in ${artifact} at row ${rowsRead}: expected ${country} and 12 fields.`)
			}

			if (columns[1].trim().toUpperCase() === key) {
				raw.push(columns)
			}
		}

		if (!rowsRead) throw new Error(`Postal export ${artifact} contains no records.`)

		results.push({ country, artifact, rows_read: rowsRead, matching_rows: raw.length, raw })
	}

	return {
		postcode,
		lookup_key: key,
		comparison: "trimmed, case-insensitive equality of the complete postcode",
		systems_checked: SYSTEM_CODES,
		candidate_systems: candidates,
		raw_columns: POSTAL_COLUMNS,
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
