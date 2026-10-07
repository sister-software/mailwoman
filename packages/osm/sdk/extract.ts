/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream rooftop address records out of a Geofabrik `.osm.pbf` extract via gdal/ogr2ogr — the same
 *   external-geo-CLI pattern `@mailwoman/tiger` uses for shapefiles. gdal's OSM driver resolves node
 *   and way/polygon geometries for us, so a building tagged with `addr:housenumber` (the dominant DE
 *   shape) becomes a point via its centroid — we don't hit the pure-JS "ways need a node-location
 *   cache" wall.
 *
 *   Address tags live in the driver's `other_tags` hstore. we pull them with ogrsql `hstore_get_value`
 *   over the `points` (nodes) and `multipolygons` (building ways/relations) layers. `addr:interpolation`
 *   ways are intentionally not read here. The rooftop tier is point-first. explicit interpolation is a
 *   separate, confidence-restricted tier (never synthesize a number line from scattered points).
 */

import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr/stream"

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
	 * `addr:street` — null when the point has no street tag (the association gap. Counted rather than written).
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
	 * `addr:place` — the scheme or estate value that stands in for a street where no
	 * `addr:street` value exists (Pakistan's `DHA Phase 6`, `Gulshan e Iqbal Block 2`).
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
	/**
	 * `addr:country` — the ISO code the mapper tagged, where one was.
	 *
	 * A Geofabrik extract's polygon extends past the border, so this is the record's
	 * own statement of which country it is in.
	 */
	country: string | null
	lon: number
	lat: number
}

/**
 * The `addr:*` tags the extract projects, in the order the record names them.
 *
 * The rooftop builder reads the first five.
 * The corpus jsonl includes them all.
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
	"country",
] as const

/**
 * A tag value as the driver returns it: absent, empty, or a string worth keeping.
 */
function tagValue(properties: Record<string, unknown>, tag: string): string | null {
	const value = properties[tag]

	return value != null && value !== "" ? String(value) : null
}

/**
 * The OSM driver layers that can have `addr:housenumber`: nodes and building ways/relations.
 */
const ADDR_LAYERS = ["points", "multipolygons"] as const

/**
 * Ogrsql projecting the `addr:*` tags out of the `other_tags` hstore,
 * filtered to rows that have a house number.
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
	const pt = representativePoint(feature.geometry ?? null)

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
		country: tagValue(p, "country"),
		lon: pt[0],
		lat: pt[1],
	}
}

/**
 * Run ogr2ogr against one layer, yielding parsed records from its GeoJSONSeq stdout.
 */
async function* runLayer(pbfPath: string, layer: string, tally?: OSMExtractTally): AsyncGenerator<OSMAddrRecord> {
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", addrSQL(layer), pbfPath]
	const counts = tally ? (tally[layer] ??= { matched: 0, emptyHouseNumber: 0, noGeometry: 0 }) : null

	for await (const feature of ogr2ogrGeoJSONSeq<{
		properties?: Record<string, unknown>
		geometry?: { type?: string; coordinates?: unknown }
	}>(args, `osm addresses (${layer})`)) {
		if (counts) {
			counts.matched++
		}

		const housenumber = feature.properties?.["housenumber"]

		if (housenumber == null || housenumber === "") {
			if (counts) {
				counts.emptyHouseNumber++
			}

			continue
		}

		const rec = toRecord(feature)

		if (rec) {
			yield rec
		} else if (counts) {
			counts.noGeometry++
		}
	}
}

/**
 * Per-layer counts of what the driver returned and what the extract discarded before yielding.
 *
 * `matched` counts the features the `addr:housenumber` filter selected in that layer.
 * A `points` feature is a node.
 *
 * A `multipolygons` feature is a closed way or relation that GDAL's OSM driver reads as an area.
 * A house number on an unclosed way is outside both layers and is not counted.
 */
export type OSMExtractTally = Record<string, { matched: number; emptyHouseNumber: number; noGeometry: number }>

/**
 * Stream every feature with `addr:housenumber` from a PBF extract (nodes + building polygons),
 * geometry reduced to a representative coordinate.
 *
 * Records with no `addr:street` are still yielded (street === null), so the caller decides
 * whether a streetless record is an address.
 * When `tally` is given, the extract records per-layer match and discard counts in it.
 */
export async function* extractAddrPoints(pbfPath: string, tally?: OSMExtractTally): AsyncGenerator<OSMAddrRecord> {
	for (const layer of ADDR_LAYERS) {
		yield* runLayer(pbfPath, layer, tally)
	}
}
