// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The street route's interface: the Worker answers it, and a browser reads it
 *   through {@linkcode RemoteStreetTable}.
 *
 *   The tier below chooses one answer from the table's rows, the same way for every country.
 */

import type {
	CrossingHit,
	CrossingTableQuery,
	StreetTableHit,
	StreetTableLookup,
	StreetTableQuery,
} from "@mailwoman/resolver-wof-sqlite/street/table"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

/**
 * The route that reads streets.
 */
export const STREET_ROUTE = "/v1/streets"

/**
 * The route that reads crossings.
 */
export const CROSSING_ROUTE = "/v1/crossings"

/**
 * One answer from either route, with the credit the source's license requires.
 */
export interface StreetRouteResponse<Hit> {
	hits: Hit[]
	attribution: string
	license: string
}

const appendPlaces = (url: URL, places: readonly number[] | undefined) => {
	for (const place of places ?? []) {
		url.searchParams.append("place", String(place))
	}
}

/**
 * Reads the street table through the Worker's routes.
 *
 * A failed request throws, because an empty answer would claim the table holds no such street.
 */
export class RemoteStreetTable implements StreetTableLookup {
	readonly #baseURL: URL

	constructor(baseURL: URL) {
		this.#baseURL = baseURL
	}

	async #read<Hit>(url: URL): Promise<Hit[]> {
		const response = await fetch(url)

		if (!response.ok) throw new Error(`The street table route answered ${response.status}`)

		const { hits } = (await response.json()) as StreetRouteResponse<Hit>

		return hits
	}

	findStreets({ street, places, near }: StreetTableQuery): Promise<StreetTableHit[]> {
		const url = new URL(STREET_ROUTE, this.#baseURL)

		url.searchParams.set("street", street)
		appendPlaces(url, places)

		if (near) {
			url.searchParams.set("near", `${near.lat},${near.lon}`)
			url.searchParams.set("radius", String(near.radiusM))
		}

		return this.#read(url)
	}

	findCrossings({ first, second, places }: CrossingTableQuery): Promise<CrossingHit[]> {
		const url = new URL(CROSSING_ROUTE, this.#baseURL)

		url.searchParams.set("first", first)
		url.searchParams.set("second", second)
		appendPlaces(url, places)

		return this.#read(url)
	}
}

/**
 * A resolved place an address states, deepest first in the list a caller passes.
 */
export interface StatedPlace {
	id: number
	lat: number
	lon: number
}

/**
 * What the street table answered, and how sure the answer is.
 */
export interface StreetTableAnswer {
	lat: number
	lon: number
	name: string
	/**
	 * The merged street's length.
	 * It bounds how far the answer can sit from the address.
	 */
	meters: number
	/**
	 * The evidence that chose this street.
	 */
	basis: "postcode" | "place" | "near_place"
	/**
	 * The other streets the same words could mean, nearest the evidence first.
	 * A non-empty list marks the answer as ambiguous.
	 */
	alternatives: StreetTableHit[]
	/**
	 * True when the address states a postcode and no street of this name lies within reach of its point.
	 */
	postcodeDisagrees: boolean
}

/**
 * How far a postcode's point may sit from a street the same address states.
 */
const POSTCODE_REACH_METERS = 2000

/**
 * How far a street may sit from a place that the table holds as a point with no extent.
 */
const PLACE_REACH_METERS = 5000

const answerFrom = (
	ranked: StreetTableHit[],
	basis: StreetTableAnswer["basis"],
	postcodeDisagrees = false
): StreetTableAnswer | null => {
	const [best, ...alternatives] = ranked

	return best
		? { lat: best.lat, lon: best.lon, name: best.name, meters: best.meters, basis, alternatives, postcodeDisagrees }
		: null
}

/**
 * Chooses a street from the table's rows.
 *
 * A postcode's point decides first, because it locates the address directly.
 * A postcode can cover an area wider than its reach, so a postcode no street reaches
 * falls through to the stated places and the answer reports the disagreement.
 *
 * Each stated place is tried deepest first, ranking its rows by distance from the place's own point.
 */
export async function readStreetFromTable(
	lookup: StreetTableLookup,
	query: { street: string; places: readonly StatedPlace[]; postcodePoint?: { lat: number; lon: number } | null }
): Promise<StreetTableAnswer | null> {
	const { street, places, postcodePoint } = query

	if (postcodePoint) {
		const near = { ...postcodePoint, radiusM: POSTCODE_REACH_METERS }

		const answer = answerFrom(await lookup.findStreets({ street, near }), "postcode")

		if (answer) return answer
	}

	const postcodeDisagrees = Boolean(postcodePoint)

	for (const place of places) {
		const hits = await lookup.findStreets({ street, places: [place.id] })

		if (hits.length) {
			const distance = ({ lat, lon }: StreetTableHit) => haversine(place.lat, place.lon, lat, lon, "meters")

			return answerFrom(
				hits.toSorted((a, b) => distance(a) - distance(b)),
				"place",
				postcodeDisagrees
			)
		}
	}

	for (const place of places) {
		const near = { lat: place.lat, lon: place.lon, radiusM: PLACE_REACH_METERS }
		const answer = answerFrom(await lookup.findStreets({ street, near }), "near_place", postcodeDisagrees)

		if (answer) return answer
	}

	return null
}
