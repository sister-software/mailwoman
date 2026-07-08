/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream rooftop address records out of a Geofabrik `.osm.pbf` extract via GDAL/ogr2ogr — the same
 *   external-geo-CLI pattern `@mailwoman/tiger` uses for shapefiles. GDAL's OSM driver resolves node
 *   AND way/polygon geometries for us, so a building tagged with `addr:housenumber` (the dominant DE
 *   shape) becomes a point via its centroid — we don't hit the pure-JS "ways need a node-location
 *   cache" wall.
 *
 *   Address tags live in the driver's `other_tags` hstore; we pull them with OGRSQL `hstore_get_value`
 *   over the `points` (nodes) and `multipolygons` (building ways/relations) layers. `addr:interpolation`
 *   ways are intentionally NOT read here — the rooftop tier is point-first; explicit interpolation is a
 *   separate, confidence-gated tier (never synthesize a number line from scattered points).
 */

import { spawn } from "node:child_process"

import { TextSpliterator } from "spliterator"

/** One OSM address feature, geometry already reduced to a single representative coordinate. */
export interface OSMAddrRecord {
	/** `addr:housenumber` — always present (the extract filters on it). */
	housenumber: string
	/** `addr:street` — null when the point carries no street tag (the association gap; counted, not written). */
	street: string | null
	postcode: string | null
	city: string | null
	lon: number
	lat: number
}

/** The OSM driver layers that can carry `addr:housenumber`: nodes and building ways/relations. */
const ADDR_LAYERS = ["points", "multipolygons"] as const

/** OGRSQL projecting the four `addr:*` tags out of the `other_tags` hstore, filtered to rows that have a house number. */
function addrSQL(layer: string): string {
	return (
		`SELECT hstore_get_value(other_tags,'addr:housenumber') AS housenumber, ` +
		`hstore_get_value(other_tags,'addr:street') AS street, ` +
		`hstore_get_value(other_tags,'addr:postcode') AS postcode, ` +
		`hstore_get_value(other_tags,'addr:city') AS city ` +
		`FROM ${layer} WHERE other_tags LIKE '%addr:housenumber%'`
	)
}

const isFinitePair = (lon: unknown, lat: unknown): boolean =>
	typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)

/** Reduce a GeoJSON geometry to one representative coordinate: the point itself, or a ring-vertex average for a polygon. */
function representativePoint(
	geom: { type?: string; coordinates?: unknown } | null | undefined
): [number, number] | null {
	if (!geom) return null

	if (geom.type === "Point") {
		const c = geom.coordinates as [number, number]

		return isFinitePair(c?.[0], c?.[1]) ? [c[0], c[1]] : null
	}

	const ring = (
		geom.type === "Polygon"
			? (geom.coordinates as number[][][])?.[0]
			: geom.type === "MultiPolygon"
				? (geom.coordinates as number[][][][])?.[0]?.[0]
				: null
	) as number[][] | null

	if (!ring || ring.length === 0) return null

	// Average the exterior-ring vertices (dropping the duplicated closing vertex). For a single
	// building footprint this lands a few metres inside the roof — fine for the rooftop tier.
	let n = ring.length

	if (n > 1 && ring[0]![0] === ring[n - 1]![0] && ring[0]![1] === ring[n - 1]![1]) {
		n--
	}
	let sx = 0
	let sy = 0

	for (let i = 0; i < n; i++) {
		sx += ring[i]![0]!
		sy += ring[i]![1]!
	}
	const lon = sx / n
	const lat = sy / n

	return isFinitePair(lon, lat) ? [lon, lat] : null
}

function toRecord(feature: {
	properties?: Record<string, unknown>
	geometry?: { type?: string; coordinates?: unknown }
}): OSMAddrRecord | null {
	const p = feature.properties ?? {}
	const housenumber = p["housenumber"]

	if (housenumber == null || housenumber === "") return null
	const pt = representativePoint(feature.geometry)

	if (!pt) return null

	return {
		housenumber: String(housenumber),
		street: p["street"] != null && p["street"] !== "" ? String(p["street"]) : null,
		postcode: p["postcode"] != null && p["postcode"] !== "" ? String(p["postcode"]) : null,
		city: p["city"] != null && p["city"] !== "" ? String(p["city"]) : null,
		lon: pt[0],
		lat: pt[1],
	}
}

/** Run ogr2ogr against one layer, yielding parsed records from its GeoJSONSeq stdout. */
async function* runLayer(pbfPath: string, layer: string): AsyncGenerator<OSMAddrRecord> {
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", addrSQL(layer), pbfPath]
	const proc = spawn("ogr2ogr", args, { stdio: ["ignore", "pipe", "pipe"] })
	let stderr = ""

	proc.stderr.on("data", (d: Buffer) => {
		stderr += d.toString()
	})
	const exit = new Promise<number>((resolve, reject) => {
		proc.on("error", reject)
		proc.on("close", resolve)
	})

	// Keep the per-line `JSON.parse` try/catch so a malformed record is tolerated (skipped), not thrown.
	for await (const raw of TextSpliterator.fromAsync(proc.stdout)) {
		// GeoJSONSeq is newline-delimited; some GDAL builds prefix each record with an RS (0x1e).
		const line = raw.replace(/^/, "").trim()

		if (!line) continue
		let feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } }

		try {
			feature = JSON.parse(line)
		} catch {
			continue
		}
		const rec = toRecord(feature)

		if (rec) {
			yield rec
		}
	}
	const code = await exit

	if (code !== 0) throw new Error(`ogr2ogr (${layer}) exited ${code}: ${stderr.slice(-800)}`)
}

/**
 * Stream every `addr:housenumber`-bearing feature from a PBF extract (nodes + building polygons), geometry reduced to a
 * representative coordinate. Records with no `addr:street` are still yielded (street === null) so the caller can COUNT
 * the association gap before deciding to write them.
 */
export async function* extractAddrPoints(pbfPath: string): AsyncGenerator<OSMAddrRecord> {
	for (const layer of ADDR_LAYERS) {
		yield* runLayer(pbfPath, layer)
	}
}
