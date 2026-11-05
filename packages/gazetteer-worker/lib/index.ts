/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The gazetteer Worker: it answers the browser resolver's `findPlace` over a service-binding RPC call, reading
 *   `candidate.db` from R2. It runs apart from the engine Worker so wa-sqlite's memory and its chunk cache stay out of
 *   the isolate that holds the classifier.
 */

import type { R2Bucket } from "@cloudflare/workers-types"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-wasm/httpvfs/resolver"
import { WorkerEntrypoint } from "cloudflare:workers"
import { ADMIN_GAZETTEER_VERSION } from "mailwoman/browser-runtime/resources"

import { openR2Database, type R2Database } from "#r2-database"

/**
 * The bindings `wrangler.toml` declares.
 */
export interface GazetteerWorkerEnv {
	/**
	 * The public asset bucket.
	 * It holds `candidate.db` at {@link candidateDatabaseKey}.
	 */
	PUBLIC_BUCKET: R2Bucket
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

interface OpenGazetteer {
	database: R2Database
	lookup: WOFCandidateTableLookup
}

/**
 * The isolate's open database.
 * A failed open is forgotten so the next call retries it.
 */
let gazetteer: Promise<OpenGazetteer> | null = null

async function openCandidateLookup(bucket: R2Bucket): Promise<OpenGazetteer> {
	const database = await openR2Database(bucket, candidateDatabaseKey())

	return { database, lookup: new WOFCandidateTableLookup(database) }
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
		const opening = (gazetteer ??= openCandidateLookup(this.env.PUBLIC_BUCKET))

		opening.catch(() => {
			if (gazetteer === opening) {
				gazetteer = null
			}
		})

		const { lookup } = await opening

		return lookup.findPlace(query)
	}

	/**
	 * Reports the open database's read counters, or null before the first query opens it.
	 */
	async readStats() {
		return gazetteer ? (await gazetteer).database.stats() : null
	}

	override async fetch(): Promise<Response> {
		return new Response("The gazetteer Worker answers over its service binding only.", { status: 404 })
	}
}
