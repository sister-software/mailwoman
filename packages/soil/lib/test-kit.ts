/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Hand-built survey areas for the fixture rung: geometry, attributes and an outline, with no network and
 *   no GDAL in the loop.
 *
 *   A FIXTURE RUNG THAT COULD ONLY RUN THROUGH ogr2ogr WOULD TEST THE CONVERSION ON THE MACHINES THAT HAVE
 *   IT AND NOTHING AT ALL ON THE ONES THAT DO NOT. What these fixtures exercise is the whole database half —
 *   the declared-domain check, the cell classification, the area-weighted reduction, the four absence
 *   shares, the coverage rows, the manifest and the seal.
 *
 *   THE ABSENCE CASES ARE THE POINT, AND IOWA HAS NONE OF THEM. Every Iowa survey area is fully digitized,
 *   so `NOTCOM`, `NOTPUB` and access-denied map units never appear in the live build — which means the only
 *   place `nodata_share` can be exercised is here. The same is true of a component whose rating is NULL for
 *   the not-rateable reason and of a class-8 rating: both exist in Iowa but sparsely, and a fixture pins the
 *   behaviour rather than hoping a county contains one.
 */

// The exterior and hole ring builders live in `@mailwoman/spatial` — a winding convention rather than this
// product's geometry, and a second copy of it is a second place for a hole to stop being one.
import { rectangleRing } from "@mailwoman/spatial"

import type { SoilComponentTable, SoilMapUnitTable } from "#schema"
import type { SoilDelineation, SoilFeatureSource } from "#sdk/ingest"
import type { SurveyAreaAttributes } from "#sdk/survey-area"

/**
 * Re-exported so a fixture in another workspace builds its rings the same way this one does.
 */

/**
 * Where the fixture geometry sits — central Iowa, so the cells it produces are the ones a real build would use.
 */
export const FIXTURE_ORIGIN = { lat: 41.6, lon: -93.6 }

/**
 * Degrees per fixture square side. About 1.6 km at this latitude — several resolution-9 cells across, so a fixture
 * square has both an interior and a fringe.
 */
export const FIXTURE_SIDE = 0.015

/**
 * The fixture map units. Each one exists to exercise exactly one reading.
 */
export function fixtureMapUnits(areaSymbol = "XX001"): SoilMapUnitTable[] {
	return [
		{
			mukey: "mu-mixed",
			areasymbol: areaSymbol,
			musym: "M1",
			muname: "Fixture complex, 0 to 2 percent slopes",
			mukind: "Complex",
			mustatus: null,
			farmlndcl: "Prime farmland if drained",
			farmland_scope: "federal",
			niccdcd: "2",
			niccdcdpct: 45,
			no_mapping: 0,
		},
		{
			mukey: "mu-class8",
			areasymbol: areaSymbol,
			musym: "M8",
			muname: "Fixture badland",
			mukind: "Consociation",
			mustatus: null,
			farmlndcl: "Not prime farmland",
			farmland_scope: "none",
			niccdcd: "8",
			niccdcdpct: 100,
			no_mapping: 0,
		},
		{
			mukey: "mu-water",
			areasymbol: areaSymbol,
			musym: "W",
			muname: "Water",
			mukind: "Consociation",
			mustatus: null,
			farmlndcl: null,
			farmland_scope: "none",
			niccdcd: null,
			niccdcdpct: null,
			no_mapping: 0,
		},
		{
			mukey: "mu-unrated",
			areasymbol: areaSymbol,
			musym: "U",
			muname: "Fixture silt loam, unrated",
			mukind: "Consociation",
			mustatus: null,
			farmlndcl: "Farmland of statewide importance",
			farmland_scope: "state",
			niccdcd: null,
			niccdcdpct: null,
			no_mapping: 0,
		},
		{
			mukey: "mu-notcom",
			areasymbol: areaSymbol,
			musym: "NOTCOM",
			muname: "No Digital Data Available",
			mukind: null,
			mustatus: null,
			farmlndcl: null,
			farmland_scope: "none",
			niccdcd: null,
			niccdcdpct: null,
			no_mapping: 1,
		},
	]
}

/**
 * The fixture components. `mu-mixed` is 45/35/20 across three classes, which is the case a winner-class schema would
 * report as "class 2" and this one reports as a mixture.
 */
export function fixtureComponents(): SoilComponentTable[] {
	return [
		component("co-mixed-1", "mu-mixed", 45, "Series", "2", "e"),
		component("co-mixed-2", "mu-mixed", 35, "Series", "3", "e"),
		component("co-mixed-3", "mu-mixed", 20, "Series", "6", "s"),
		component("co-class8", "mu-class8", 100, "Series", "8", "s"),
		// A miscellaneous area with no rating: NOT RATEABLE, which is not the same as unrated and not the same as class 8.
		component("co-water", "mu-water", 100, "Miscellaneous area", null, null),
		// A named soil the survey did not rate: UNRATED.
		component("co-unrated", "mu-unrated", 100, "Series", null, null),
		// A minority component small enough to fall under the truncation floor once the lattice splits it.
		component("co-tail", "mu-mixed", 1, "Series", "7", "e"),
	]
}

function component(
	cokey: string,
	mukey: string,
	comppct: number,
	compkind: string,
	nirrcapcl: string | null,
	nirrcapscl: string | null
): SoilComponentTable {
	return {
		cokey,
		mukey,
		comppct_r: comppct,
		compname: cokey,
		compkind,
		nirrcapcl,
		nirrcapscl,
		irrcapcl: null,
		irrcapscl: null,
		nccpi_v3: null,
	}
}

/**
 * The declared domains a fixture build validates and stores, matching what the real `msdomdet.txt` ships.
 */
export function fixtureDomains(): SurveyAreaAttributes["domains"] {
	const members: SurveyAreaAttributes["domains"] = []

	for (const [index, code] of ["1", "2", "3", "4", "5", "6", "7", "8"].entries()) {
		members.push({
			domain: "capability_class",
			code,
			sequence: index + 1,
			definition: `Soils in Class ${code} — fixture definition.`,
		})
	}

	for (const [index, code] of ["e", "w", "s", "c"].entries()) {
		members.push({ domain: "capability_subclass", code, sequence: index + 1, definition: `Fixture subclass ${code}.` })
	}

	return members
}

/**
 * The fixture delineations: a mixed square, a class-8 square, a water square, an unrated square, and a `NOTCOM` square,
 * laid out left to right so each occupies its own ground.
 */
export function fixtureDelineations(areaSymbol = "XX001"): SoilDelineation[] {
	const { lat, lon } = FIXTURE_ORIGIN
	const mukeys = ["mu-mixed", "mu-class8", "mu-water", "mu-unrated", "mu-notcom"]

	return mukeys.map((mukey, index) => ({
		areaID: `${areaSymbol}:${index}`,
		mukey,
		areasymbol: areaSymbol,
		polygons: [[rectangleRing(lon + index * FIXTURE_SIDE, lat, lon + (index + 1) * FIXTURE_SIDE, lat + FIXTURE_SIDE)]],
	}))
}

/**
 * The outline covering every fixture delineation, with margin — the survey area's own footprint.
 *
 * The margin is nearly a degree because the coverage test is CONSERVATIVE: `interiorCoverageCellSet` keeps only cells
 * lying wholly inside the outline, and a resolution-6 cell is about 36 km across. An outline the size of the fixture
 * squares yields zero interior cells and the build refuses — correctly, since an artifact with no coverage rows answers
 * unknown everywhere while reporting success.
 */
export function fixtureOutline(margin = 0.75): { type: "Polygon"; coordinates: number[][][] } {
	const { lat, lon } = FIXTURE_ORIGIN

	return {
		type: "Polygon",
		coordinates: [
			rectangleRing(lon - margin, lat - margin, lon + 5 * FIXTURE_SIDE + margin, lat + FIXTURE_SIDE + margin),
		],
	}
}

/**
 * A feature source over hand-built delineations.
 */
export function fixtureSource(delineations: SoilDelineation[], areaSymbol = "XX001"): SoilFeatureSource {
	return {
		areaSymbol,
		declaredFeatureCount: delineations.length,
		layer: `soilmu_a_${areaSymbol.toLowerCase()}`,
		epsg: 4326,
		origin: "fixture",
		async *delineations() {
			for (const delineation of delineations) {
				yield delineation
			}
		},
	}
}

/**
 * One fixture survey area's attributes.
 *
 * `areaAcres` is left NULL on purpose: the area cross-check compares against what the AUTHORITY publishes, and a
 * fixture that invented an acreage would be checking this package's arithmetic against itself.
 */
export function fixtureAttributes(areaSymbol = "XX001"): SurveyAreaAttributes {
	return {
		areasymbol: areaSymbol,
		areaname: "Fixture County, Iowa",
		saverest: "2025-09-09",
		saversion: 1,
		surveySourceDate: "1960",
		surveySourceTitle: "Soil Survey of Fixture County, Iowa",
		sourceScale: 15_840,
		mappingScale: 12_000,
		areaAcres: null,
		mapUnits: fixtureMapUnits(areaSymbol),
		components: fixtureComponents(),
		domains: fixtureDomains(),
	}
}
