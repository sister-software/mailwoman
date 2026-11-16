// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The text that writes and labels a point query, apart from the reader.
 *
 *   The reader in `reading.ts` imports the recognition engine and three artifacts.
 *   A page that only writes a coordinate pair or labels a kind in a sentence imports this module.
 *   This module holds none of the engine, because its one import is a type and the build erases it.
 */

import type { PointQueryKind } from "#point/reading"

/**
 * A coordinate pair as text, latitude first, in the form `pointFromText` reads back.
 *
 * Six decimals place a point within about 11 cm.
 */
export function coordinatePairText(lat: number, lon: number, decimals = 6): string {
	return `${lat.toFixed(decimals)}, ${lon.toFixed(decimals)}`
}

/**
 * Labels a recognized shape in a result panel and in a sentence.
 */
export interface PointQueryDescription {
	/**
	 * The name a result is shown under, such as the tag column of a parse.
	 */
	readonly label: string
	/**
	 * The same name as a noun phrase with its article: "this is a plus code".
	 */
	readonly phrase: string
}

const COORDINATE_PAIR = { label: "coordinates", phrase: "a coordinate pair" } as const
const CENSUS_GEOID = { label: "Census GEOID", phrase: "a Census GEOID" } as const
const GNIS_ID = { label: "GNIS id", phrase: "a GNIS feature id" } as const
const H3_CELL = { label: "H3 cell", phrase: "an H3 cell" } as const
const WOF_ID = { label: "Who's On First id", phrase: "a Who's On First id" } as const

/**
 * The description of every kind, so a new kind in any composed family fails the build until it has one.
 */
export const POINT_QUERY_DESCRIPTIONS = {
	"coordinate.decimal_pair": COORDINATE_PAIR,
	"coordinate.decimal_pair_spaced": COORDINATE_PAIR,
	"coordinate.dms_pair": COORDINATE_PAIR,
	"coordinate.dms_pair_spaced": COORDINATE_PAIR,
	"coordinate.geo_uri": COORDINATE_PAIR,
	"coordinate.labeled_pair": COORDINATE_PAIR,
	"coordinate.maps_segment": COORDINATE_PAIR,
	"plus_code.token": { label: "plus code", phrase: "a plus code" },
	"digipin.compact": { label: "DIGIPIN", phrase: "a DIGIPIN" },
	"digipin.display": { label: "DIGIPIN", phrase: "a DIGIPIN" },
	"geojson.object": { label: "GeoJSON", phrase: "a GeoJSON object" },
	"census.geoid_block": CENSUS_GEOID,
	"census.geoid_block_group": CENSUS_GEOID,
	"census.geoid_county": CENSUS_GEOID,
	"census.geoid_state": CENSUS_GEOID,
	"census.geoid_tract": CENSUS_GEOID,
	"geohash.prefixed": { label: "geohash", phrase: "a geohash" },
	"gnis.reference": GNIS_ID,
	"gnis.summary_url": GNIS_ID,
	"h3.cell": H3_CELL,
	"h3.prefixed_cell": H3_CELL,
	"wof.reference": WOF_ID,
	"wof.spelunker_url": WOF_ID,
} satisfies Readonly<Record<PointQueryKind, PointQueryDescription>>
