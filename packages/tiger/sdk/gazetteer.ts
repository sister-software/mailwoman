// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The Census Bureau's national gazetteer files: one row per place or county subdivision, with its
 *   GEOID, its GNIS feature id (`ANSICODE`), its legal/statistical area description, its functional
 *   status and an interior point.
 *
 *   The GNIS id ties a Census entity to the GNIS populated place of the same feature, and the GEOID ties
 *   it to a Who's On First record holding it as its `uscensus:geoid` concordance. A GNIS place whose
 *   Census entity a WOF record already holds is the same place, whatever either source calls it.
 *
 *   A work of the United States Government, public domain under 17 U.S.C. § 105.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { extractZipEntries } from "@mailwoman/core/fs/zip"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { downloadIfNeeded } from "#sdk/download"

/**
 * The gazetteer files {@link fetchCensusGazetteer} reads, by the name the Census Bureau files them under.
 */
export const CensusGazetteerKind = {
	Place: "place",
	CountySubdivision: "cousubs",
} as const

export type CensusGazetteerKind = (typeof CensusGazetteerKind)[keyof typeof CensusGazetteerKind]

/**
 * One row of a Census gazetteer file.
 */
export interface CensusGazetteerEntry {
	kind: CensusGazetteerKind
	/**
	 * The USPS state code.
	 */
	state: string
	geoid: string
	/**
	 * The GNIS feature id, from the zero-padded `ANSICODE`.
	 */
	gnisID: number
	name: string
	/**
	 * The legal/statistical area description code (`LSAD`), or `null` in the county subdivision file.
	 * That file has no `LSAD` column.
	 */
	lsad: string | null
	/**
	 * The functional status code (`FUNCSTAT`), as `TIGERFunctionalStatus` defines it.
	 */
	functionalStatus: string
	latitude: number
	longitude: number
}

/**
 * The gazetteer vintage {@link fetchCensusGazetteer} reads unless told otherwise.
 */
export const DEFAULT_CENSUS_GAZETTEER_VINTAGE = 2024

function gazetteerFileName(kind: CensusGazetteerKind, vintage: number): string {
	return `${vintage}_Gaz_${kind}_national`
}

/**
 * Downloads one national gazetteer file into `<dataRoot>/tiger/<vintage>/`
 * unless a valid copy is there, and returns the path of its extracted text file.
 */
export async function fetchCensusGazetteer(
	kind: CensusGazetteerKind,
	options: { vintage?: number; dataRoot?: PathBuilderLike } = {}
): Promise<PathBuilder> {
	const vintage = options.vintage ?? DEFAULT_CENSUS_GAZETTEER_VINTAGE
	const directory = PathBuilder.from(options.dataRoot ?? dataRootPath())("tiger", String(vintage))
	const name = gazetteerFileName(kind, vintage)
	const zipPath = directory(`${name}.zip`)

	await makeDirectories(directory)

	await downloadIfNeeded(
		`https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${vintage}_Gazetteer/${name}.zip`,
		zipPath
	)

	await extractZipEntries(zipPath, directory, { skipExisting: true })

	return directory(`${name}.txt`)
}

/**
 * Reads a national gazetteer text file.
 *
 * The files are tab-separated with a header row, and they pad the last column with trailing spaces.
 *
 * @throws When the header lacks a column the reader needs.
 */
export async function* readCensusGazetteer(
	path: PathBuilderLike,
	kind: CensusGazetteerKind
): AsyncGenerator<CensusGazetteerEntry> {
	let header: string[] | null = null

	const at = (column: string): number => {
		const index = header!.indexOf(column)

		if (index === -1) throw new Error(`${path}: the gazetteer header has no ${column} column`)

		return index
	}

	for await (const fields of readUnquotedTSV(path)) {
		const row = fields.map((field) => String(field ?? "").trim())

		if (!header) {
			header = row

			continue
		}

		yield {
			kind,
			state: row[at("USPS")]!,
			geoid: row[at("GEOID")]!,
			gnisID: Number(row[at("ANSICODE")]),
			name: row[at("NAME")]!,
			lsad: header.includes("LSAD") ? row[at("LSAD")]! : null,
			functionalStatus: row[at("FUNCSTAT")]!,
			latitude: Number(row[at("INTPTLAT")]),
			longitude: Number(row[at("INTPTLONG")]),
		}
	}
}
