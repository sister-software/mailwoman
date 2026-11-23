// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The gazetteer Worker: it answers the browser resolver's `findPlace` over a
 *   service-binding RPC call, reading `candidate.db` from R2.
 *
 *   It runs apart from the engine Worker so wa-sqlite's memory and its chunk cache
 *   stay out of the isolate that holds the classifier.
 *
 *   It also holds the two landmark layers.
 *   `findLandmarks` answers the engine Worker, and `GET /v1/landmarks` answers a browser.
 *
 *   The OpenStreetMap database sits in a bucket with no public route,
 *   so this bounded lookup is the one way to read it.
 */

import type { LandmarkHit } from "@mailwoman/core/resolver"
import type { CrossingHit, StreetTableArea, StreetTableHit } from "@mailwoman/resolver-wof-sqlite/labels/street/table"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import {
	LANDMARK_ROUTE,
	LandmarkSource,
	type LandmarkRouteResponse,
} from "@mailwoman/resolver-wof-wasm/remote/landmark"
import { CROSSING_ROUTE, STREET_ROUTE, type StreetRouteResponse } from "@mailwoman/resolver-wof-wasm/remote/street"
import { WorkerEntrypoint } from "cloudflare:workers"

import {
	GazetteerServices,
	type GazetteerWorkerEnv,
	gazetteerScope,
	LandmarkLookupServices,
	readCandidateDatabaseStats,
} from "#services"

/**
 * One `findPlace` query, as the browser resolver's cascade sends it.
 */
export type PlaceQuery = Parameters<MailwomanLookupLike["findPlace"]>[0]

/**
 * The candidates for one query, in the shape the cascade reads.
 */
export type PlaceCandidates = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>

/**
 * The longest name the route reads.
 * A longer name answers 400 and reads no R2 object.
 */
const LANDMARK_NAME_LIMIT = 200

/**
 * The credit and license each layer requires beside its hits.
 */
const LANDMARK_LICENSES: Record<LandmarkSource, Pick<LandmarkRouteResponse, "attribution" | "license">> = {
	[LandmarkSource.Wikidata]: { attribution: "Wikidata", license: "CC0-1.0" },
	[LandmarkSource.OpenStreetMap]: { attribution: "© OpenStreetMap contributors", license: "ODbL-1.0" },
}

function isLandmarkSource(source: string | null): source is LandmarkSource {
	return source === LandmarkSource.Wikidata || source === LandmarkSource.OpenStreetMap
}

/**
 * The credit the street table's source requires beside its answers.
 */
const STREET_TABLE_LICENSE = {
	attribution: "Contains OS data © Crown copyright and database right 2026",
	license: "OGL-UK-3.0",
}

const STREET_NAME_LIMIT = 200

/**
 * The most places one street or crossing read scopes to.
 */
const STREET_PLACE_LIMIT = 8

/**
 * The largest radius a street read searches, in meters.
 */
const STREET_RADIUS_LIMIT = 20_000

/**
 * Reads the route's repeated `place` parameter, or null when one is malformed or they exceed the limit.
 */
function readPlaces(url: URL): number[] | null {
	const places = url.searchParams.getAll("place").map(Number)

	return places.length <= STREET_PLACE_LIMIT && places.every(Number.isSafeInteger) ? places : null
}

/**
 * Reads the route's `near` and `radius` parameters, undefined when absent and null when malformed.
 */
function readArea(url: URL): StreetTableArea | undefined | null {
	const near = url.searchParams.get("near")

	if (!near) return undefined

	const [lat, lon] = near.split(",").map(Number)
	const radiusM = Number(url.searchParams.get("radius"))

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

	if (!(radiusM > 0 && radiusM <= STREET_RADIUS_LIMIT)) return null

	return { lat: lat!, lon: lon!, radiusM }
}

const CROSS_ORIGIN = { "Access-Control-Allow-Origin": "*" }

const isWrittenStreet = (street: string | undefined): street is string =>
	Boolean(street) && street!.length <= STREET_NAME_LIMIT

/**
 * The service-binding entry point.
 *
 * A caller binds this Worker and calls `findPlace` on the binding.
 */
export default class GazetteerWorker extends WorkerEntrypoint<GazetteerWorkerEnv> {
	/**
	 * Answers one query with the browser lookup's candidates.
	 */
	async findPlace(query: PlaceQuery): Promise<PlaceCandidates> {
		const lookup = await gazetteerScope(this.env).resolve(GazetteerServices.candidateLookup)

		return lookup.findPlace(query)
	}

	/**
	 * Answers one name from one landmark layer, best first.
	 */
	async findLandmarks(name: string, source: LandmarkSource): Promise<LandmarkHit[]> {
		const lookup = await gazetteerScope(this.env).resolve(LandmarkLookupServices[source])

		return lookup.find(name)
	}

	/**
	 * Reports the open database's read counters, or null before the first query opens it.
	 */
	readStats() {
		return readCandidateDatabaseStats()
	}

	/**
	 * Answers `GET /v1/landmarks?name=&source=`, the one route a browser reaches.
	 * Each answer holds the layer's credit and license.
	 */
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (request.method === "GET" && (url.pathname === STREET_ROUTE || url.pathname === CROSSING_ROUTE)) {
			return this.#answerStreetRoute(url)
		}

		if (url.pathname !== LANDMARK_ROUTE || request.method !== "GET") {
			return new Response("The gazetteer Worker answers place lookups over its service binding.", { status: 404 })
		}

		const name = url.searchParams.get("name")?.trim()
		const source = url.searchParams.get("source")

		if (!name || name.length > LANDMARK_NAME_LIMIT || !isLandmarkSource(source)) {
			return new Response(`name of 1 to ${LANDMARK_NAME_LIMIT} characters and a landmark source are required.`, {
				status: 400,
			})
		}

		const crossOrigin = { "Access-Control-Allow-Origin": "*" }

		try {
			const answer: LandmarkRouteResponse = {
				hits: await this.findLandmarks(name, source),
				source,
				...LANDMARK_LICENSES[source],
			}

			return Response.json(answer, { headers: { ...crossOrigin, "Cache-Control": "public, max-age=86400" } })
		} catch (error) {
			// A browser reads the status only when the failure holds the cross-origin header.
			console.error(`The ${source} landmark layer could not be read`, error)

			return new Response(`The ${source} landmark layer could not be read.`, { status: 503, headers: crossOrigin })
		}
	}

	/**
	 * Answers `GET /v1/streets?street=&place=&near=&radius=` and `GET /v1/crossings?first=&second=&place=`.
	 */
	async #answerStreetRoute(url: URL): Promise<Response> {
		const places = readPlaces(url)
		const near = readArea(url)
		const refuse = (message: string) => new Response(message, { status: 400, headers: CROSS_ORIGIN })

		if (!places || near === null) {
			return refuse(`At most ${STREET_PLACE_LIMIT} place ids and a radius up to ${STREET_RADIUS_LIMIT} m are allowed.`)
		}

		try {
			const lookup = await gazetteerScope(this.env).resolve(GazetteerServices.streetTable)
			let hits: Array<StreetTableHit | CrossingHit>

			if (url.pathname === STREET_ROUTE) {
				const street = url.searchParams.get("street")?.trim()

				if (!isWrittenStreet(street) || (!places.length && !near)) {
					return refuse(`street of 1 to ${STREET_NAME_LIMIT} characters and a place or a near point are required.`)
				}

				hits = await lookup.findStreets({ street, places, ...(near ? { near } : {}) })
			} else {
				const first = url.searchParams.get("first")?.trim()
				const second = url.searchParams.get("second")?.trim()

				if (!isWrittenStreet(first) || !isWrittenStreet(second)) {
					return refuse(`first and second of 1 to ${STREET_NAME_LIMIT} characters are required.`)
				}

				hits = await lookup.findCrossings({ first, second, places })
			}

			const answer: StreetRouteResponse<StreetTableHit | CrossingHit> = { hits, ...STREET_TABLE_LICENSE }

			return Response.json(answer, { headers: { ...CROSS_ORIGIN, "Cache-Control": "public, max-age=86400" } })
		} catch (error) {
			console.error("The street table could not be read", error)

			return new Response("The street table could not be read.", { status: 503, headers: CROSS_ORIGIN })
		}
	}
}
