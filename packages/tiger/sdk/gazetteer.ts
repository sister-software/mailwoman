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
	/**
	 * Core based statistical areas: the metropolitan and micropolitan statistical areas the
	 * Office of Management and Budget delineates. {@link readCBSAGazetteer} reads this file.
	 */
	CoreBasedStatisticalArea: "cbsa",
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

/**
 * The two kinds of core based statistical area.
 */
export const CBSAKind = {
	Metropolitan: "metropolitan",
	Micropolitan: "micropolitan",
} as const

export type CBSAKind = (typeof CBSAKind)[keyof typeof CBSAKind]

/**
 * One row of the core based statistical area gazetteer file.
 */
export interface CBSAGazetteerEntry {
	/**
	 * The area's five-digit CBSA code, `10180`.
	 */
	geoid: string
	/**
	 * The area's title with its designator, `Abilene, TX Metro Area`.
	 */
	title: string
	/**
	 * The area's title without its designator, `Abilene, TX`.
	 */
	name: string
	kind: CBSAKind
	/**
	 * The code of the combined statistical area the area belongs to, or `null`.
	 */
	combinedArea: string | null
	latitude: number
	longitude: number
}

const CBSA_DESIGNATOR = / (?:Metro|Micro) Area$/u

/**
 * Reads the national core based statistical area gazetteer file.
 *
 * `CBSA_TYPE` is `1` for a metropolitan area and `2` for a micropolitan one.
 *
 * @throws When the header lacks a column the reader needs, or a row states another type.
 */
export async function* readCBSAGazetteer(path: PathBuilderLike): AsyncGenerator<CBSAGazetteerEntry> {
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

		const type = row[at("CBSA_TYPE")]
		const title = row[at("NAME")]!

		if (type !== "1" && type !== "2") {
			throw new Error(`${path}: CBSA ${row[at("GEOID")]} states CBSA_TYPE ${type}`)
		}

		yield {
			geoid: row[at("GEOID")]!,
			title,
			name: title.replace(CBSA_DESIGNATOR, ""),
			kind: type === "1" ? CBSAKind.Metropolitan : CBSAKind.Micropolitan,
			combinedArea: row[at("CSAFP")] || null,
			latitude: Number(row[at("INTPTLAT")]),
			longitude: Number(row[at("INTPTLONG")]),
		}
	}
}
