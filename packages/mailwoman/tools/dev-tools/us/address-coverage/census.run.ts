// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the per-county US address coverage census as JSON, and prints a state summary.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/us/address-coverage/census.run.ts --out
 *   <file.json> [--layer-root <dir> --layer-version <version>] [--admin-db <db>] [--polygon-db <db>]
 *
 *   With `--layer-root`, the points are the US address layer's records under that root's `addresses/`
 *   directory, such as `$MAILWOMAN_DATA_ROOT/db`, rather than each state's address-point database.
 *   A layer record without a postcode is placed in a county by location:
 *   each 0.01° cell gets one county lookup against `wof-polygons-us-full.db`,
 *   and the county's `uscensus:geoid` concordance gives its FIPS code.
 *
 *   The denominator is ACS 2021 five-year table B25024, read from api.census.gov with `US_CENSUS_API_KEY`.
 *   Each state's counties are that table's set, and a point placed in a code
 *   the table lacks is counted as unmatched.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { US_FIPS_STATE } from "@mailwoman/corpus/us/fips-state"
import {
	addressLayerManifestPath,
	type AddressLayerCountryManifest,
} from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import {
	addressPointDatabasePath,
	interpolationDatabasePath,
	wofDatabasePath,
} from "@mailwoman/resolver-wof-sqlite/paths"
import { WOFReverseGeocoder } from "@mailwoman/resolver-wof-sqlite/reverse"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { $private } from "#env"
import {
	attributePoints,
	type CountyCoverage,
	coverageRatio,
	fetchCountyHousing,
	THIN_COUNTY_RATIO,
} from "#tools/dev-tools/us/address-coverage/census"

const { values } = parseArguments({
	options: {
		out: { type: "string" },
		"layer-root": { type: "string" },
		"layer-version": { type: "string" },
		"admin-db": {
			type: "string",
			description: "The admin gazetteer (default: the data root's admin-global-priority.db)",
		},
		"polygon-db": {
			type: "string",
			description: "The US county polygons (default: the data root's wof-polygons-us-full.db)",
		},
	},
})

const adminDBPath = values["admin-db"] ?? wofDatabasePath("admin-global-priority.db").toString()
const polygonDBPath = values["polygon-db"] ?? wofDatabasePath("wof-polygons-us-full.db").toString()

if (!values.out) throw new Error("--out <file.json> is required")

const layerRoot = values["layer-root"]
const layerVersion = values["layer-version"]

if ((layerRoot == null) !== (layerVersion == null)) {
	throw new Error("--layer-root and --layer-version are given together")
}

/**
 * The version's US manifest, read once.
 *
 * A version can keep regions an earlier version built, so a region's file is the path
 * its manifest entry names, never one rebuilt from the version.
 */
const layerManifest =
	layerRoot != null && layerVersion != null
		? await readLocalJSONFile<AddressLayerCountryManifest>(addressLayerManifestPath(layerRoot, "US", layerVersion))
		: null

/**
 * The database holding a state's address points and the table to count: the `detail.db` the US address
 * layer's manifest names when `--layer-root` is given, else the state's address-point database.
 */
function pointsSource(state: string): { path: string; table: string } {
	if (layerManifest && layerRoot != null) {
		const region = layerManifest.regions.find((entry) => entry.region === `us-${state}`)

		const path = region
			? resolvePath(layerRoot, region.detail.path).toString()
			: `us-${state} (absent from the manifest)`

		return { path, table: "address" }
	}

	return { path: addressPointDatabasePath(`address-points-us-${state}.db`).toString(), table: "address_point" }
}

const EXTRACT_NAME = /^interpolation-us-([a-z]{2})\.db$/u

const apiKey = $private.US_CENSUS_API_KEY

if (!apiKey)
	throw new Error("US_CENSUS_API_KEY is not set; request a key at https://api.census.gov/data/key_signup.html")

const housing = await fetchCountyHousing(apiKey)

const files = (
	await Globerator.files("db", { cwd: interpolationDatabasePath, absolute: false, recursive: false }).toSorted()
).filter((file) => EXTRACT_NAME.test(file))

const counties: CountyCoverage[] = []

const states: Array<{
	state: string
	housingUnits: number
	structures: number
	addressPoints: number
	withoutPostcode: number
	unattributed: number
	/**
	 * Points placed in a county code the ACS table lacks, so no county of the state holds them.
	 */
	unmatched: number
	/**
	 * Layer records without a postcode placed in a county by the county polygon containing their cell.
	 */
	placedByLocation: number
	/**
	 * Layer records without a postcode placed by a county's bounding box,
	 * because the sidecar holds no polygon for it.
	 */
	placedByBox: number
	/**
	 * Layer records without a postcode whose cell no US county contains.
	 */
	unplaced: number
	unreadable: boolean
}> = []

/**
 * The county lookup for layer records without a postcode, with each US county's
 * census GEOID by Who's On First id.
 * It is built only in layer mode.
 */
const reverse =
	layerRoot != null
		? {
				geocoder: new WOFReverseGeocoder({ adminDBPath, polygonDBPath }),
				geoidByWOFID: readCountyGEOIDs(),
			}
		: null

/**
 * Each current US county's `uscensus:geoid` concordance, the five-digit FIPS code the gazetteer keys by.
 */
function readCountyGEOIDs(): Map<number, string> {
	using admin = new DatabaseClient<never>(adminDBPath, { readOnly: true })

	const rows = admin
		.prepare(
			`select c.id id, c.other_id geoid from concordances c join spr s on s.id = c.id
			 where c.other_source = 'uscensus:geoid' and s.country = 'US' and s.placetype = 'county' and s.is_current = 1`
		)
		.all() as Array<{ id: number; geoid: string }>

	if (!rows.length) throw new Error("admin-global-priority.db holds no uscensus:geoid concordance for a US county")

	return new Map(rows.map((row) => [row.id, row.geoid]))
}

for (const file of files) {
	const state = EXTRACT_NAME.exec(file)![1]!
	using segmentsDB = new DatabaseClient<never>(interpolationDatabasePath(file), { readOnly: true })

	const segments = segmentsDB
		.prepare(
			"select coalesce(postcode, '') postcode, county_fips county, count(*) segments from street_segment group by 1, 2"
		)
		.all() as Array<{ postcode: string; county: string; segments: number }>

	const { path: pointsPath, table } = pointsSource(state)
	const hasPoints = await pathExists(pointsPath)

	// The layer is built for every state, so a missing region is a wrong root
	// or version and never a state with no points.
	if (!hasPoints && layerRoot != null) {
		throw new Error(`${pointsPath} does not exist; --layer-root is the directory that holds addresses/`)
	}

	const pointsByPostcode = new Map<string, number>()
	let withoutPostcode = 0

	if (hasPoints) {
		using pointsDB = new DatabaseClient<never>(pointsPath, { readOnly: true })

		const rows = pointsDB
			.prepare(`select coalesce(postcode, '') postcode, count(*) points from ${table} group by 1`)
			.all() as Array<{ postcode: string; points: number }>

		for (const { postcode, points } of rows) {
			if (!postcode) {
				withoutPostcode += points
			}
			// In layer mode every record is placed by location below, so the postcode split isn't used.
			else if (!reverse) {
				pointsByPostcode.set(postcode, points)
			}
		}
	}

	const { byCounty, unattributed } = attributePoints(
		pointsByPostcode,
		segments.filter((row) => row.postcode)
	)

	// A layer record is placed in its county by location: one county lookup per 0.01° cell.
	// Every layer record has a point, so layer mode places all of them this way
	// and leaves the postcode split to the address-point databases.
	let placedByLocation = 0
	let placedByBox = 0
	let unplaced = 0

	if (reverse && hasPoints) {
		using pointsDB = new DatabaseClient<never>(pointsPath, { readOnly: true })

		const cells = pointsDB
			.prepare(`select round(lat, 2) lat, round(lon, 2) lon, count(*) points from ${table} group by 1, 2`)
			.all() as Array<{ lat: number; lon: number; points: number }>

		for (const cell of cells) {
			const result = await reverse.geocoder.reverseGeocode(cell.lat, cell.lon, { placetypes: ["county"] })
			const county = result.hierarchy.find((place) => place.placetype === "county")
			const geoid = county ? reverse.geoidByWOFID.get(Number(county.id)) : undefined

			if (!geoid) {
				unplaced += cell.points

				continue
			}

			byCounty.set(geoid, (byCounty.get(geoid) ?? 0) + cell.points)

			if (result.containment === "approximate") {
				placedByBox += cell.points
			} else {
				placedByLocation += cell.points
			}
		}
	}

	const segmentsByCounty = new Map<string, number>()

	for (const { county, segments: count } of segments) {
		segmentsByCounty.set(county, (segmentsByCounty.get(county) ?? 0) + count)
	}

	// The state's counties are the ACS table's, the county set Who's On First places points in.
	// The interpolation databases' TIGER county codes are a separate column and can differ.
	const stateFIPS = Object.entries(US_FIPS_STATE).find(([, info]) => info.abbreviation === state.toUpperCase())?.[0]

	if (!stateFIPS) throw new Error(`${state} has no FIPS state code`)

	const stateCounties = [...housing]
		.filter(([fips]) => fips.startsWith(stateFIPS))
		.map(([fips, county]) => ({
			fips,
			...county,
			addressPoints: Math.round(byCounty.get(fips) ?? 0),
			streetSegments: segmentsByCounty.get(fips) ?? 0,
		}))

	// Points placed in a code the ACS table lacks are counted, never dropped.
	const unmatched = [...byCounty].filter(([fips]) => !housing.has(fips)).reduce((sum, [, points]) => sum + points, 0)

	counties.push(...stateCounties)

	states.push({
		state,
		housingUnits: stateCounties.map((county) => county.housingUnits).reduce((sum, units) => sum + units, 0),
		structures: Math.round(stateCounties.map((county) => county.structures).reduce((sum, count) => sum + count, 0)),
		addressPoints: stateCounties.map((county) => county.addressPoints).reduce((sum, points) => sum + points, 0),
		withoutPostcode,
		unattributed,
		unmatched: Math.round(unmatched),
		placedByLocation,
		placedByBox,
		unplaced,
		unreadable: !hasPoints,
	})
}

await writeLocalJSONFile(
	{ denominator: "ACS 2021 five-year B25024, estimated structures", states, counties },
	resolvePath(values.out)
)

console.log(["state", "structures", "points", "ratio", "without postcode", "unattributed", "unmatched"].join("\t"))

for (const row of states.toSorted((a, b) => (coverageRatio(a) ?? 0) - (coverageRatio(b) ?? 0))) {
	console.log(
		[
			row.state,
			row.structures,
			row.addressPoints,
			coverageRatio(row)?.toFixed(3),
			row.withoutPostcode,
			row.unattributed,
			row.unmatched,
		].join("\t")
	)
}

const thin = counties.filter((county) => (coverageRatio(county) ?? 1) < THIN_COUNTY_RATIO)
const structures = Math.round(thin.map((county) => county.structures).reduce((sum, count) => sum + count, 0))

console.log(
	`counties: ${counties.length}; under a quarter of estimated structures: ${thin.length}, holding ${structures} structures`
)
