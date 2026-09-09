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
 *   separate, confidence-restricted tier (never synthesize a number line from scattered points).
 */

import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"

import { representativePoint } from "#sdk/representative-point"

/**
 * One OSM address feature, geometry already reduced to a single representative coordinate.
 */
export interface OSMAddrRecord {
	/**
	 * `addr:housenumber` — always present (the extract filters on it).
	 */
	housenumber: string
	/**
	 * `addr:street` — null when the point carries no street tag (the association gap; counted, not written).
	 */
	street: string | null
	postcode: string | null
	suburb: string | null
	city: string | null
	/**
	 * `addr:unit` — the secondary-unit designator, where a country tags one.
	 */
	unit: string | null
	/**
	 * `addr:place` — the named scheme or estate that stands in for a street where none is named (Pakistan's `DHA Phase
	 * 6`, `Gulshan e Iqbal Block 2`).
	 */
	place: string | null
	/**
	 * `addr:subdistrict` — the ward below a district (Vietnam's `Phường Tân Phú`).
	 */
	subdistrict: string | null
	/**
	 * `addr:district` — the district below the city or province (Vietnam's `Quận 7`, `Hoàn Kiếm`).
	 */
	district: string | null
	/**
	 * `addr:province` — the province, where the mapper tagged one beside or instead of a city.
	 */
	province: string | null
	lon: number
	lat: number
}

/**
 * The `addr:*` tags the extract projects, in the order the record names them. The rooftop builder reads the first five;
 * the corpus JSONL carries them all.
 */
const ADDR_TAGS = [
	"housenumber",
	"street",
	"postcode",
	"suburb",
	"city",
	"unit",
	"place",
	"subdistrict",
	"district",
	"province",
] as const

/**
 * A tag value as the driver returns it: absent, empty, or a string worth keeping.
 */
function tagValue(properties: Record<string, unknown>, tag: string): string | null {
	const value = properties[tag]

	return value != null && value !== "" ? String(value) : null
}

/**
 * The OSM driver layers that can carry `addr:housenumber`: nodes and building ways/relations.
 */
const ADDR_LAYERS = ["points", "multipolygons"] as const

/**
 * OGRSQL projecting the `addr:*` tags out of the `other_tags` hstore, filtered to rows that have a house number.
 */
function addrSQL(layer: string): string {
	const projection = ADDR_TAGS.map((tag) => `hstore_get_value(other_tags,'addr:${tag}') AS ${tag}`).join(", ")

	return `SELECT ${projection} FROM ${layer} WHERE other_tags LIKE '%addr:housenumber%'`
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
		street: tagValue(p, "street"),
		postcode: tagValue(p, "postcode"),
		suburb: tagValue(p, "suburb"),
		city: tagValue(p, "city"),
		unit: tagValue(p, "unit"),
		place: tagValue(p, "place"),
		subdistrict: tagValue(p, "subdistrict"),
		district: tagValue(p, "district"),
		province: tagValue(p, "province"),
		lon: pt[0],
		lat: pt[1],
	}
}

/**
 * Run ogr2ogr against one layer, yielding parsed records from its GeoJSONSeq stdout.
 */
async function* runLayer(pbfPath: string, layer: string): AsyncGenerator<OSMAddrRecord> {
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", addrSQL(layer), pbfPath]

	for await (const feature of ogr2ogrGeoJSONSeq<{
		properties?: Record<string, unknown>
		geometry?: { type?: string; coordinates?: unknown }
	}>(args, `osm addresses (${layer})`)) {
		const rec = toRecord(feature)

		if (rec) {
			yield rec
		}
	}
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
