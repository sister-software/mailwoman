// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads one country's GeoNames postal export from a directory of them, complete and checked.
 *
 *   A directory holds each country as `<CC>.txt`, or as the `<CC>.zip` archive
 *   GeoNames publishes with `<CC>.txt` as its member.
 *   The reader yields every record with its twelve columns as text, so a postcode keeps its leading zeroes.
 *
 *   A record with another column count, another country code or an empty postcode
 *   raises an error, and so does an export without records.
 *   A caller therefore never mistakes a short or damaged export for a postcode's absence.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { type PathBuilderLike, resolvePath } from "path-ts"
import { TSVSpliterator } from "spliterator"

/**
 * The columns of a GeoNames postal export record, in source order.
 * Administrative codes belong to GeoNames and its sources.
 */
export const GEONAMES_POSTAL_EXPORT_COLUMNS = [
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
 * The form two postcodes are compared in: trimmed and upper-cased, with inner spacing and punctuation kept.
 */
export function geonamesPostcodeKey(postcode: string): string {
	return postcode.trim().toUpperCase()
}

/**
 * The two files a directory may hold for `country`, in the order the reader prefers them.
 */
export function geonamesPostalExportPaths(directory: PathBuilderLike, country: string): { text: string; zip: string } {
	const code = country.toUpperCase()

	return {
		text: resolvePath(directory.toString(), `${code}.txt`),
		zip: resolvePath(directory.toString(), `${code}.zip`),
	}
}

/**
 * The export file `directory` holds for `country`: its `<CC>.txt`, else its `<CC>.zip`, else `null`.
 */
export async function findGeonamesPostalExport(directory: PathBuilderLike, country: string): Promise<string | null> {
	const { text, zip } = geonamesPostalExportPaths(directory, country)

	if (await pathExists(text)) return text

	return (await pathExists(zip)) ? zip : null
}

/**
 * Every record of the export at `artifact`, a path {@linkcode findGeonamesPostalExport} returned.
 *
 * @throws When a record lacks the twelve columns, states another country or has an
 * empty postcode, and after the last record when the export held none.
 */
export async function* readGeonamesPostalExport(artifact: string, country: string): AsyncGenerator<string[]> {
	const code = country.toUpperCase()

	const rows = artifact.endsWith(".zip")
		? (TSVSpliterator.fromAsync(readZipEntry(artifact, `${code}.txt`), {
				header: false,
				enableQuoteHandling: false,
			}) as AsyncIterable<string[]>)
		: readUnquotedTSV(artifact)

	let rowsRead = 0

	for await (const columns of rows) {
		rowsRead++

		if (columns.length !== GEONAMES_POSTAL_EXPORT_COLUMNS.length || columns[0] !== code || !columns[1]) {
			throw new Error(`Invalid postal record in ${artifact} at row ${rowsRead}: expected ${code} and 12 fields.`)
		}

		yield columns
	}

	if (!rowsRead) throw new Error(`Postal export ${artifact} contains no records.`)
}
