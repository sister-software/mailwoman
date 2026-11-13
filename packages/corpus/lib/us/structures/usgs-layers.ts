// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The point layers of the USGS National Map structures MapServer, one entry per layer the
 *   fetcher pulls, the adapter trains on, and the structures layer folds into `structures.db`.
 *
 *   The service publishes every layer twice: layers 0–34 are the `Labels` group
 *   and serve the same rows as the `Features` layers 35 ids above them.
 *   The table lists the `Features` layers.
 *
 *   The group layers (35, 36, 48, 52, 55, 59, 68) hold no features.
 *
 *   Each layer is queried by its own id rather than by feature code, because a feature
 *   code isn't unique to a layer: Campgrounds (60) and Shelters (63) are both FCODE 82008.
 *
 *   Layer 69, `Alaska Pipeline`, is left out: it holds polylines with no name, address
 *   or feature-level identifier, so it is neither a venue nor an address.
 */

/**
 * One point layer of the structures MapServer.
 */
export interface USGSStructureLayer {
	/**
	 * The layer's id in the MapServer's `Features` group.
	 */
	layerID: number
	/**
	 * A stable identifier for the layer, stored on every fetched feature as `layer`.
	 */
	slug: string
	/**
	 * The layer's name as the service states it.
	 */
	name: string
	/**
	 * The `@mailwoman/poi-taxonomy` category id a feature of the layer is filed under.
	 */
	poiCategory: string
	/**
	 * Whether the adapter emits venue-and-address training rows for the layer.
	 *
	 * A layer whose features have no street address (picnic areas, cabins, trailheads)
	 * is a retrieval layer only: its few addressed features describe the access road
	 * of a remote site rather than a delivery address.
	 */
	trains: boolean
}

/**
 * Every point layer of the structures MapServer, in layer-id order.
 */
export const USGS_STRUCTURE_LAYERS: readonly USGSStructureLayer[] = [
	{ layerID: 37, slug: "cemeteries", name: "Cemeteries", poiCategory: "cemeteries", trains: true },
	{ layerID: 38, slug: "post-offices", name: "Post Offices", poiCategory: "post_office", trains: true },
	{ layerID: 39, slug: "city-town-halls", name: "City/Town Halls", poiCategory: "town_hall", trains: true },
	{ layerID: 40, slug: "courthouses", name: "Courthouses", poiCategory: "courthouse", trains: true },
	{
		layerID: 41,
		slug: "state-capitols",
		name: "State Capitols",
		poiCategory: "local_and_state_government_offices",
		trains: true,
	},
	{ layerID: 42, slug: "state-supreme-courts", name: "State Supreme Courts", poiCategory: "courthouse", trains: true },
	{
		layerID: 43,
		slug: "white-house",
		name: "The White House",
		poiCategory: "federal_government_offices",
		trains: true,
	},
	{ layerID: 44, slug: "us-capitol", name: "U.S. Capitol", poiCategory: "federal_government_offices", trains: true },
	{ layerID: 45, slug: "us-supreme-court", name: "U.S. Supreme Court", poiCategory: "courthouse", trains: true },
	{
		layerID: 46,
		slug: "historic-sites",
		name: "Historic Sites/Points of Interest",
		poiCategory: "landmark_and_historical_building",
		trains: false,
	},
	{
		layerID: 47,
		slug: "national-symbols-monuments",
		name: "National Symbols/Monuments",
		poiCategory: "monument",
		trains: false,
	},
	{ layerID: 49, slug: "hospitals", name: "Hospitals/Medical Centers", poiCategory: "hospital", trains: true },
	{
		layerID: 50,
		slug: "ambulance-services",
		name: "Ambulance Services",
		poiCategory: "ambulance_and_ems_services",
		trains: true,
	},
	{
		layerID: 51,
		slug: "fire-ems-stations",
		name: "Fire Stations/EMS Stations",
		poiCategory: "fire_station",
		trains: true,
	},
	{ layerID: 53, slug: "police-stations", name: "Police Stations", poiCategory: "police_station", trains: true },
	{
		layerID: 54,
		slug: "prisons",
		name: "Prisons/Correctional Facilities",
		poiCategory: "jail_and_prison",
		trains: true,
	},
	{
		layerID: 56,
		slug: "colleges-universities",
		name: "Colleges/Universities",
		poiCategory: "college_university",
		trains: true,
	},
	{
		layerID: 57,
		slug: "technical-trade-schools",
		name: "Technical/Trade Schools",
		poiCategory: "vocational_and_technical_school",
		trains: true,
	},
	{ layerID: 58, slug: "schools", name: "Schools", poiCategory: "school", trains: true },
	{ layerID: 60, slug: "campgrounds", name: "Campgrounds", poiCategory: "campground", trains: false },
	{ layerID: 61, slug: "trailheads", name: "Trailheads", poiCategory: "trail", trains: false },
	{ layerID: 62, slug: "cabins", name: "Cabins", poiCategory: "cabin", trains: false },
	// The publisher files shelters under the campground feature code, 82008.
	{ layerID: 63, slug: "shelters", name: "Shelters", poiCategory: "campground", trains: false },
	{ layerID: 64, slug: "picnic-areas", name: "Picnic Areas", poiCategory: "park", trains: false },
	{
		layerID: 65,
		slug: "headquarters",
		name: "Headquarters",
		poiCategory: "federal_government_offices",
		trains: true,
	},
	{
		layerID: 66,
		slug: "visitor-centers",
		name: "Visitor/Information Centers",
		poiCategory: "visitor_center",
		trains: true,
	},
	{
		layerID: 67,
		slug: "ranger-stations",
		name: "Ranger Stations",
		poiCategory: "federal_government_offices",
		trains: true,
	},
]

const BY_ID = new Map(USGS_STRUCTURE_LAYERS.map((layer) => [layer.layerID, layer]))

/**
 * The layer with id `layerID`.
 *
 * @throws When the table holds no such layer, so a feature from an unlisted layer
 * is never filed under a guessed category.
 */
export function usgsStructureLayer(layerID: number): USGSStructureLayer {
	const layer = BY_ID.get(layerID)

	if (!layer) throw new Error(`the USGS structures layer table holds no layer ${layerID}`)

	return layer
}
