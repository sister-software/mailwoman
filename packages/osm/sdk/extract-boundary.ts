/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Administrative-boundary extractor — pull ONE named `boundary=administrative` multipolygon out of a
 *   Geofabrik `.osm.pbf` extract via GDAL/ogr2ogr and hand back its GeoJSON geometry. Mirrors
 *   `extract-poi.ts`'s process-spawn + GeoJSONSeq-over-stdout idiom; the differences are that it keeps the
 *   GEOMETRY rather than reducing it to a representative point, and that it refuses anything other than
 *   exactly one match.
 *
 *   Why the geometry and not a bounding box: a coverage claim keyed on a rectangle asserts survey over
 *   whatever the rectangle overhangs, and a country/region extract is clipped to a polygon, not a
 *   rectangle. `bboxCoverageCells` in the POI pipeline is correct for the rectangular cuts it was written
 *   for; a named administrative region needs its own outline or the cells along its edge claim coverage
 *   the source never had.
 *
 *   Refusing a multi-match is the point, not politeness. `name` is not unique in OSM even within one
 *   admin level, and silently taking the first row would key a completeness claim to whichever feature
 *   the driver happened to emit first — indistinguishable downstream from the region the caller meant.
 */

import { spawn } from "node:child_process"

import { tryParsingJSON } from "@mailwoman/core/objects"
import type { GeojsonGeometry } from "@mailwoman/spatial"
import { TextSpliterator } from "spliterator"

/**
 * The OSM driver layer administrative boundaries land in. Relations and closed ways both surface here.
 */
const BOUNDARY_LAYER = "multipolygons"

/**
 * Same allowlist discipline as `extract-poi.ts`'s `SAFE_TAG_TOKEN`, widened to the characters a real place name carries
 * (`Île-de-France`, `Provence-Alpes-Côte d'Azur`). The value is interpolated into an OGRSQL string literal, so an
 * apostrophe is admissible only because it is doubled below; every other quoting metacharacter is refused outright.
 */
const SAFE_NAME = /^[\p{L}\p{N} '’\-.()/]+$/u

/**
 * `admin_level` is compared as an OGRSQL string literal; OSM only ever carries small integers here.
 */
const SAFE_ADMIN_LEVEL = /^[0-9]{1,2}$/

export interface OSMBoundaryQuery {
	/**
	 * The boundary relation's `name` tag, matched exactly.
	 */
	name: string
	/**
	 * The boundary's `admin_level` tag — 4 for a French région or a German Land, 6 for a French département.
	 */
	adminLevel: string
}

export interface OSMBoundary extends OSMBoundaryQuery {
	/**
	 * GeoJSON `Polygon` or `MultiPolygon`, lon/lat, holes included.
	 */
	geometry: GeojsonGeometry
	/**
	 * The matched feature's OSM id, so a build can record WHICH boundary it keyed its claim to.
	 */
	osmID: string
}

/**
 * Build the OGRSQL SELECT+WHERE for one boundary query. Exported for unit testing — no `ogr2ogr` involved.
 *
 * Throws if `name` or `adminLevel` falls outside the allowlists above, before any string concatenation happens.
 */
export function buildBoundarySQL(query: OSMBoundaryQuery): string {
	if (!SAFE_NAME.test(query.name)) {
		throw new Error(
			`buildBoundarySQL: name ${JSON.stringify(query.name)} contains characters outside the place-name allowlist ` +
				`${SAFE_NAME} — refusing to interpolate it into OGRSQL`
		)
	}

	if (!SAFE_ADMIN_LEVEL.test(query.adminLevel)) {
		throw new Error(
			`buildBoundarySQL: adminLevel ${JSON.stringify(query.adminLevel)} must be 1-2 digits, got a value outside ` +
				`${SAFE_ADMIN_LEVEL}`
		)
	}

	const name = query.name.replaceAll("'", "''")

	return (
		`SELECT osm_id, name, admin_level FROM ${BOUNDARY_LAYER} ` +
		`WHERE boundary='administrative' AND admin_level='${query.adminLevel}' AND name='${name}'`
	)
}

/**
 * Read the one boundary matching `query` out of `pbfPath`. Throws when the extract holds no match or more than one.
 */
export async function extractOSMBoundary(pbfPath: string, query: OSMBoundaryQuery): Promise<OSMBoundary> {
	const sql = buildBoundarySQL(query)
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", sql, pbfPath]
	const proc = spawn("ogr2ogr", args, { stdio: ["ignore", "pipe", "pipe"] })
	let stderr = ""

	proc.stderr.on("data", (d: Buffer) => {
		stderr += d.toString()
	})

	const exit = new Promise<number>((resolve, reject) => {
		proc.on("error", reject)
		proc.on("close", resolve)
	})

	const matches: OSMBoundary[] = []

	for await (const raw of TextSpliterator.fromAsync(proc.stdout)) {
		const line = raw.trim()

		if (!line) continue

		const feature = tryParsingJSON<{
			properties?: Record<string, unknown>
			geometry?: GeojsonGeometry
		}>(line)

		if (!feature?.geometry) continue

		matches.push({
			...query,
			geometry: feature.geometry,
			osmID: String(feature.properties?.["osm_id"] ?? ""),
		})
	}

	const code = await exit

	if (code !== 0) throw new Error(`ogr2ogr (boundary) exited ${code}: ${stderr.slice(-800)}`)

	if (matches.length !== 1) {
		throw new Error(
			`extractOSMBoundary: expected exactly 1 boundary named ${JSON.stringify(query.name)} at admin_level ` +
				`${query.adminLevel} in ${pbfPath}, found ${matches.length}`
		)
	}

	return matches[0]!
}
