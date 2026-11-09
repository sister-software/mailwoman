/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the per-county US address coverage census as JSON, and prints a state summary.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/us/address-coverage/census.run.ts --out <file.json>
 *   [--layer-root <dir> --layer-version <version>]
 *
 *   With `--layer-root`, the points are the US address layer's records under that root's `addresses/` directory, such
 *   as `$MAILWOMAN_DATA_ROOT/db`, rather than each state's address-point database. A layer record without a postcode
 *   is placed in a county by location: each 0.01° cell gets one county lookup against `wof-polygons-us-full.db`, and the
 *   county's `uscensus:geoid` concordance gives the gazetteer's GEOID.
 *
 *   The denominator is `<data root>/census/Gaz_counties_national.txt`, the unzipped gazetteer that
 *   `COUNTY_GAZETTEER_URL` serves.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { addressLayerFiles } from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import {
	addressPointDatabasePath,
	interpolationDatabasePath,
	wofDatabasePath,
} from "@mailwoman/resolver-wof-sqlite/paths"
import { WOFReverseGeocoder } from "@mailwoman/resolver-wof-sqlite/reverse"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import {
	attributePoints,
	type CountyCoverage,
	coverageRatio,
	readCountyHousingUnits,
	THIN_COUNTY_RATIO,
} from "#tools/dev-tools/us/address-coverage/census"

const { values } = parseArguments({
	options: { out: { type: "string" }, "layer-root": { type: "string" }, "layer-version": { type: "string" } },
})

if (!values.out) throw new Error("--out <file.json> is required")

const layerRoot = values["layer-root"]
const layerVersion = values["layer-version"]

if ((layerRoot == null) !== (layerVersion == null)) {
	throw new Error("--layer-root and --layer-version are given together")
}

/**
 * The database holding a state's address points and the table to count: the US address
 * layer's `detail.db` when `--layer-root` is given, else the state's address-point database.
 */
function pointsSource(state: string): { path: string; table: string } {
	if (layerRoot != null && layerVersion != null) {
		return {
			path: addressLayerFiles(resolvePath(layerRoot), `us-${state}`, layerVersion).detail.toString(),
			table: "address",
		}
	}

	return { path: addressPointDatabasePath(`address-points-us-${state}.db`).toString(), table: "address_point" }
}

const EXTRACT_NAME = /^interpolation-us-([a-z]{2})\.db$/u

const housing = readCountyHousingUnits(await readLocalTextFile(dataRootPath("census", "Gaz_counties_national.txt")))

const files = (
	await Globerator.files("db", { cwd: interpolationDatabasePath, absolute: false, recursive: false }).toSorted()
).filter((file) => EXTRACT_NAME.test(file))

const counties: CountyCoverage[] = []

const states: Array<{
	state: string
	housingUnits: number
	addressPoints: number
	withoutPostcode: number
	unattributed: number
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
				geocoder: new WOFReverseGeocoder({
					adminDBPath: wofDatabasePath("admin-global-priority.db"),
					polygonDBPath: wofDatabasePath("wof-polygons-us-full.db"),
				}),
				geoidByWOFID: readCountyGEOIDs(),
			}
		: null

/**
 * Each current US county's `uscensus:geoid` concordance, the five-digit FIPS code the gazetteer keys by.
 */
function readCountyGEOIDs(): Map<number, string> {
	using admin = new DatabaseClient<never>(wofDatabasePath("admin-global-priority.db"), { readOnly: true })

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
			if (postcode) {
				pointsByPostcode.set(postcode, points)
			} else {
				withoutPostcode += points
			}
		}
	}

	const { byCounty, unattributed } = attributePoints(
		pointsByPostcode,
		segments.filter((row) => row.postcode)
	)

	// A layer record without a postcode is placed in its county by location: one county lookup per 0.01° cell.
	let placedByLocation = 0
	let placedByBox = 0
	let unplaced = 0

	if (reverse && hasPoints && withoutPostcode > 0) {
		using pointsDB = new DatabaseClient<never>(pointsPath, { readOnly: true })

		const cells = pointsDB
			.prepare(
				`select round(lat, 2) lat, round(lon, 2) lon, count(*) points from ${table} where postcode is null group by 1, 2`
			)
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

	const stateCounties = [...segmentsByCounty.keys()].map((fips) => ({
		fips,
		housingUnits: housing.get(fips) ?? 0,
		addressPoints: Math.round(byCounty.get(fips) ?? 0),
		streetSegments: segmentsByCounty.get(fips) ?? 0,
	}))

	counties.push(...stateCounties)

	states.push({
		state,
		housingUnits: stateCounties.map((county) => county.housingUnits).reduce((sum, units) => sum + units, 0),
		addressPoints: stateCounties.map((county) => county.addressPoints).reduce((sum, points) => sum + points, 0),
		withoutPostcode,
		unattributed,
		placedByLocation,
		placedByBox,
		unplaced,
		unreadable: !hasPoints,
	})
}

await writeLocalJSONFile({ denominator: "2010 Census HU10", states, counties }, resolvePath(values.out))

for (const row of states.toSorted((a, b) => a.addressPoints / a.housingUnits - b.addressPoints / b.housingUnits)) {
	const ratio = coverageRatio(row)

	console.log(
		[row.state, row.housingUnits, row.addressPoints, ratio?.toFixed(3), row.withoutPostcode, row.unattributed].join(
			"\t"
		)
	)
}

const thin = counties.filter((county) => (coverageRatio(county) ?? 1) < THIN_COUNTY_RATIO)
const units = thin.map((county) => county.housingUnits).reduce((sum, count) => sum + count, 0)

console.log(`counties: ${counties.length}; under a quarter of housing units: ${thin.length}, holding ${units} units`)
