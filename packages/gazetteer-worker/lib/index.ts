/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The gazetteer Worker: it answers the browser resolver's `findPlace` over a service-binding RPC call, reading
 *   `candidate.db` from R2. It runs apart from the engine Worker so wa-sqlite's memory and its chunk cache stay out of
 *   the isolate that holds the classifier.
 *
 *   It also holds the two landmark layers. `findLandmarks` answers the engine Worker, and `GET /v1/landmarks` answers a
 *   browser. The OpenStreetMap database sits in a bucket with no public route, so this bounded lookup is the one way
 *   to read it.
 */

import type { R2Bucket } from "@cloudflare/workers-types"
import type { LandmarkHit } from "@mailwoman/core/resolver"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { RangeLandmarkLookup } from "@mailwoman/resolver-wof-wasm/httpvfs/landmark"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-wasm/httpvfs/resolver"
import {
	LANDMARK_ROUTE,
	LandmarkSource,
	type LandmarkRouteResponse,
} from "@mailwoman/resolver-wof-wasm/remote-landmark"
import { WorkerEntrypoint } from "cloudflare:workers"
import { ADMIN_GAZETTEER_VERSION } from "mailwoman/browser-runtime/resources"

import { openR2Database } from "#r2-database"

/**
 * The bindings `wrangler.toml` declares.
 */
export interface GazetteerWorkerEnv {
	/**
	 * The public asset bucket.
	 * It holds `candidate.db` at {@link candidateDatabaseKey}.
	 */
	PUBLIC_BUCKET: R2Bucket
	/**
	 * The bucket that holds the OpenStreetMap place database, at a key no tile Worker route serves.
	 */
	OSM_PLACES_BUCKET: R2Bucket
}

/**
 * One `findPlace` query, as the browser resolver's cascade sends it.
 */
export type PlaceQuery = Parameters<MailwomanLookupLike["findPlace"]>[0]

/**
 * The candidates for one query, in the shape the cascade reads.
 */
export type PlaceCandidates = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>

/**
 * The key of the admin gazetteer's candidate database in the public bucket:
 * the browser's `adminGazetteerURL()` path, without the bucket's host.
 */
export function candidateDatabaseKey(): string {
	return `mailwoman/gazetteer/${ADMIN_GAZETTEER_VERSION}/candidate.db`
}

/**
 * The key of the Wikidata landmark database in the public bucket.
 */
export const LANDMARK_DATABASE_KEY = "mailwoman/landmarks/2026-11-06/landmarks.db"

/**
 * The key of the OpenStreetMap place database.
 * The key states the planet index its rows came from.
 */
export const OSM_PLACES_DATABASE_KEY = "osm-places/planet-2026-08-03/places-osm.db"

/**
 * The most rows one name reads from a landmark layer, best first.
 *
 * On the 2026-08-03 planet build, 1,303 of 3,778,629 names hold more rows than this.
 */
const LANDMARK_ROW_LIMIT = 100

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

/**
 * Returns the one call that opens a resource for this isolate.
 * A failed open is forgotten so the next call retries it.
 */
function openOncePerIsolate<T>(open: (env: GazetteerWorkerEnv) => Promise<T>) {
	let opened: Promise<T> | null = null

	return {
		open(env: GazetteerWorkerEnv): Promise<T> {
			const opening = (opened ??= open(env))

			opening.catch(() => {
				if (opened === opening) {
					opened = null
				}
			})

			return opening
		},
		current: () => opened,
	}
}

const gazetteer = openOncePerIsolate(async (env) => {
	const database = await openR2Database(env.PUBLIC_BUCKET, candidateDatabaseKey())

	return { database, lookup: new WOFCandidateTableLookup(database) }
})

// A landmark read probes one clustered key, so 64 chunks of 64 KiB hold it, a quarter of the candidate cache.
const LANDMARK_CACHE = { maxChunks: 64 }

const landmarkLookups: Record<LandmarkSource, ReturnType<typeof openOncePerIsolate<RangeLandmarkLookup>>> = {
	[LandmarkSource.Wikidata]: openOncePerIsolate(
		async (env) =>
			new RangeLandmarkLookup(
				await openR2Database(env.PUBLIC_BUCKET, LANDMARK_DATABASE_KEY, LANDMARK_CACHE),
				LANDMARK_ROW_LIMIT
			)
	),
	[LandmarkSource.OpenStreetMap]: openOncePerIsolate(
		async (env) =>
			new RangeLandmarkLookup(
				await openR2Database(env.OSM_PLACES_BUCKET, OSM_PLACES_DATABASE_KEY, LANDMARK_CACHE),
				LANDMARK_ROW_LIMIT
			)
	),
}

function isLandmarkSource(source: string | null): source is LandmarkSource {
	return source === LandmarkSource.Wikidata || source === LandmarkSource.OpenStreetMap
}

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
		const { lookup } = await gazetteer.open(this.env)

		return lookup.findPlace(query)
	}

	/**
	 * Answers one name from one landmark layer, best first.
	 */
	async findLandmarks(name: string, source: LandmarkSource): Promise<LandmarkHit[]> {
		const lookup = await landmarkLookups[source].open(this.env)

		return lookup.find(name)
	}

	/**
	 * Reports the open database's read counters, or null before the first query opens it.
	 */
	async readStats() {
		const opening = gazetteer.current()

		return opening ? (await opening).database.stats() : null
	}

	/**
	 * Answers `GET /v1/landmarks?name=&source=`, the one route a browser reaches.
	 * Each answer holds the layer's credit and license.
	 */
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

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
}
