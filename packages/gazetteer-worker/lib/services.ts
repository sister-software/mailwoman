// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The databases the gazetteer Worker reads, as services on one `async-init` registry per isolate.
 *
 *   Each database opens on the first request that needs it, and every later
 *   request in the isolate reads the same one.
 *   An open that fails is forgotten, so the next request tries again.
 *
 *   The Worker never disposes the registry.
 *   The platform ends an isolate without notice, and each database is read-only.
 */

import type { R2Bucket } from "@cloudflare/workers-types"
import { RangeLandmarkLookup } from "@mailwoman/resolver-wof-wasm/httpvfs/landmark"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-wasm/httpvfs/resolver"
import { RangeStreetTable } from "@mailwoman/resolver-wof-wasm/httpvfs/street/table"
import { LandmarkSource } from "@mailwoman/resolver-wof-wasm/remote/landmark"
import { createToken, ServiceRegistry, ServiceState, type ServiceToken } from "async-init"
import { ADMIN_GAZETTEER_VERSION } from "mailwoman/browser-runtime/resources"

import { openR2Database, type R2Database, type R2DatabaseStats } from "#r2-database"

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
 * The key of the street table in the public bucket.
 * The key states the source and date its rows came from.
 */
export const STREET_TABLE_KEY = "mailwoman/streets/gb-os-open-roads-2026-11-07b/streets.db"

/**
 * The most rows one name reads from a landmark layer, best first.
 *
 * On the 2026-08-03 planet build, 1,303 of 3,778,629 names hold more rows than this.
 */
const LANDMARK_ROW_LIMIT = 100

// A landmark read probes one clustered key, so 64 chunks of 64 KiB hold it, a quarter of the candidate cache.
const LANDMARK_CACHE = { maxChunks: 64 }

/**
 * The tokens of the Worker's services.
 */
export const GazetteerServices = {
	candidateDatabase: createToken<R2Database>("candidate-database"),
	candidateLookup: createToken<WOFCandidateTableLookup>("candidate-lookup"),
	streetTable: createToken<RangeStreetTable>("street-table"),
} as const

/**
 * The token of each landmark layer's lookup.
 */
export const LandmarkLookupServices: Record<LandmarkSource, ServiceToken<RangeLandmarkLookup>> = {
	[LandmarkSource.Wikidata]: createToken("landmarks-wikidata"),
	[LandmarkSource.OpenStreetMap]: createToken("landmarks-openstreetmap"),
}

/**
 * Defines the Worker's services on a new registry, reading each database from `env`'s buckets.
 */
export function createGazetteerScope(env: GazetteerWorkerEnv): ServiceRegistry {
	const scope = new ServiceRegistry()

	scope.define(GazetteerServices.candidateDatabase, {
		build: () => openR2Database(env.PUBLIC_BUCKET, candidateDatabaseKey()),
	})

	scope.define(GazetteerServices.candidateLookup, {
		needs: { database: GazetteerServices.candidateDatabase },
		build: ({ database }) => new WOFCandidateTableLookup(database),
	})

	scope.define(LandmarkLookupServices[LandmarkSource.Wikidata], {
		build: async () =>
			new RangeLandmarkLookup(
				await openR2Database(env.PUBLIC_BUCKET, LANDMARK_DATABASE_KEY, LANDMARK_CACHE),
				LANDMARK_ROW_LIMIT
			),
	})

	scope.define(LandmarkLookupServices[LandmarkSource.OpenStreetMap], {
		build: async () =>
			new RangeLandmarkLookup(
				await openR2Database(env.OSM_PLACES_BUCKET, OSM_PLACES_DATABASE_KEY, LANDMARK_CACHE),
				LANDMARK_ROW_LIMIT
			),
	})

	scope.define(GazetteerServices.streetTable, {
		build: async () => new RangeStreetTable(await openR2Database(env.PUBLIC_BUCKET, STREET_TABLE_KEY, LANDMARK_CACHE)),
	})

	return scope
}

let isolateScope: ServiceRegistry | null = null

/**
 * The isolate's registry, created from the first request's bindings.
 *
 * Every request in an isolate has the same bindings, so the registry keeps the first request's `env`.
 */
export function gazetteerScope(env: GazetteerWorkerEnv): ServiceRegistry {
	return (isolateScope ??= createGazetteerScope(env))
}

/**
 * The read counters of the candidate database, or `null` before a request has opened it.
 *
 * A database whose open is still in flight is awaited.
 */
export async function readCandidateDatabaseStats(): Promise<R2DatabaseStats | null> {
	const scope = isolateScope
	const database = scope?.graph().find((service) => service.token === GazetteerServices.candidateDatabase)

	if (!scope || !database) return null

	if (database.state !== ServiceState.Ready && database.state !== ServiceState.Resolving) return null

	return (await scope.resolve(GazetteerServices.candidateDatabase)).stats()
}
