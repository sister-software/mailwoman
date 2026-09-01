/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Tags returned by the Overpass API for a node.
 *
 * @category OSM
 */
export const OSMNodeTag = {
	HouseNumber: "addr:housenumber",
	PostCode: "addr:postcode",
	Street: "addr:street",
	State: "addr:state",
	City: "addr:city",
	Website: "website",
	Email: "email",
	Phone: "phone",
	Shop: "shop",
	Brand: "brand",
	Cuisine: "cuisine",
	Name: "name",
	Healthcare: "healthcare",
	Office: "office",
	Amenity: "amenity",
} as const

export type OSMNodeTag = (typeof OSMNodeTag)[keyof typeof OSMNodeTag]

/**
 * OSM node tags that disqualify a node from being treated as residential — a node carrying one of these is
 * infrastructure or commercial, whatever else it claims.
 */
export const ForbiddenResidentialOSMNodeTags: ReadonlySet<OSMNodeTag> = new Set<OSMNodeTag>([
	OSMNodeTag.Shop,
	OSMNodeTag.Brand,
	OSMNodeTag.Cuisine,
	OSMNodeTag.Office,
	OSMNodeTag.Healthcare,
])

export type OSMNodeTagRecord = Record<OSMNodeTag, string | undefined>

export interface OSMOverpassElement {
	type: "node"
	id: number
	lat: number
	lon: number
	tags: OSMNodeTagRecord
}

export interface OSMOverpassResponseBody {
	version: string
	generator: string
	osm3s: {
		timestamp_osm_base: string
		copyright: string
	}
	elements: OSMOverpassElement[]
}

/**
 * Given an OSM element, attempts to infer if the result is a residential address.
 */
export function isResidentialElement(element: OSMOverpassElement): boolean {
	for (const key in element.tags) {
		if (ForbiddenResidentialOSMNodeTags.has(key as OSMNodeTag)) return false
	}

	if (element.tags[OSMNodeTag.Amenity] === "restaurant") return false

	return true
}
