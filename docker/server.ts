/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Container entrypoint for the `ghcr.io/sister-software/mailwoman` image. It serves the native
 *   `/v1` API from packages bundled in the image. Unlike `mailwoman serve`, it starts without a
 *   gazetteer and exposes parsing and health checks until data is available.
 *
 *   The engine uses the same exported geocoding and resolver building blocks as the CLI. English
 *   model weights are bundled; gazetteer databases are mounted read-only at `$MAILWOMAN_DATA_ROOT`.
 *
 *   Parsing and health are available when weights load. Geocoding and batch processing also require
 *   a resolvable gazetteer; otherwise their routes return `503`. Missing weights disable parsing with
 *   `501`.
 *
 *   The container listens on `0.0.0.0:3000`; publish another host port with `docker run -p`.
 *   Nominatim, Photon, and libpostal drop-in servers are also available in the image; see
 *   `docker/readme.md`.
 */

import { createMailwomanAPI } from "@mailwoman/api"
import type { MailwomanAPIEngine, GeocodeCallback, GeocodeOutcomeLike, BatchResultEntry } from "@mailwoman/api"
import { serveNode } from "@mailwoman/api-kit"
import { decodeAsTuples, decodeAsXML } from "@mailwoman/core"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { $public } from "mailwoman/env"
import { geocodeAddress, RegionDatabaseProvider } from "mailwoman/geocode"
import { createResolverBackend, resolveCandidateDBPath, resolveWOFDatabasePaths } from "mailwoman/resolver-backend"
import { AsyncSequence } from "spliterator"

const PORT = 3000
const HOST = "0.0.0.0"
const DATA_ROOT = dataRootPath()

/**
 * Resolve WOF extract paths.
 *
 * An explicit `$MAILWOMAN_WOF_DB` list is used as supplied; conventional paths
 * are filtered to files that exist.
 */
function wofPaths(): Promise<string[]> {
	const paths = resolveWOFDatabasePaths()

	if ($public.MAILWOMAN_WOF_DB) return Promise.resolve(paths)

	return AsyncSequence.from(paths).parallelFilter(pathExists).toArray()
}

/**
 * Build the engine, enabling geocoding only when weights and a gazetteer are available.
 */
async function buildEngine<T extends GeocodeOutcomeLike = GeocodeOutcomeLike>() {
	const engine: MailwomanAPIEngine<T> = {
		health: async () => ({
			data: {
				data_root: DATA_ROOT,
			},
		}),
	}

	// Load weights independently so gazetteer failures do not disable parsing.
	const classifier: NeuralAddressClassifier | null = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		.then((c) => {
			engine.parse = (address, opts) =>
				c.parse(address, { postcodeRepair: true }).then((tree) => {
					return {
						input: address,
						components: decodeAsTuples(tree).map(([tag, value]) => ({ tag, value })),
						tree,
						debug: opts.debug ? decodeAsXML(tree) : undefined,
					}
				})

			return c
		})
		.catch((error) => {
			// Leave parsing unavailable; the API returns 501 for this route.
			console.error(`[mailwoman] neural weights not found — /v1/parse disabled (501): ${error}`)

			return null
		})

	// Geocoding and batch processing require both the classifier and a gazetteer.
	if (classifier) {
		const candidateDB = await resolveCandidateDBPath()
		const paths = await wofPaths()

		if (candidateDB || paths.length) {
			try {
				const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
				const backend = await createResolverBackend(resolverMod, { wofPaths: paths })
				const resolver = createWOFResolver(backend)
				const extracts = await RegionDatabaseProvider.create(resolverMod, DATA_ROOT)
				// Candidate lookup is country-agnostic; the FTS backend defaults to US.
				const defaultCountry = candidateDB ? undefined : "US"

				const oneGeocode: GeocodeCallback<T> = (address: string) =>
					geocodeAddress(address, { classifier, resolver, databases: extracts.for, defaultCountry }) as Promise<T>

				engine.geocode = async (address) => oneGeocode(address)

				engine.batch = async (addresses) => {
					const inputs = addresses.map((a) => a.trim())
					const results: BatchResultEntry<T>[] = Array.from({ length: inputs.length })

					for (let i = 0; i < inputs.length; i++) {
						const input = inputs[i]!

						try {
							results[i] = await oneGeocode(input)
						} catch (error) {
							results[i] = { input, error: error instanceof Error ? error.message : String(error) }
						}
					}

					return { results }
				}

				console.error(`[mailwoman] gazetteer found — /v1/geocode + /v1/batch enabled (data root: ${DATA_ROOT})`)
			} catch (error) {
				// Keep parsing available if the gazetteer cannot be opened.
				console.error(
					`[mailwoman] gazetteer at ${DATA_ROOT} could not be opened — /v1/geocode + /v1/batch answer 503: ${error}`
				)
			}
		} else {
			console.error(
				`[mailwoman] no gazetteer at ${DATA_ROOT} — booting parse-only (/v1/geocode + /v1/batch answer 503).\n` +
					`[mailwoman] mount one read-only to enable geocoding: docker run -v <host-data>:/data:ro …`
			)
		}
	}

	return engine
}

const engine = await buildEngine()
const app = createMailwomanAPI(engine, { batchMax: Math.max(1, $public.MAILWOMAN_BATCH_MAX) })

await using handle = await serveNode({
	fetch: app.fetch,
	port: PORT,
	hostname: HOST,
})

let draining = false

const shutdown = () => {
	if (draining) return
	draining = true

	console.error("[mailwoman] draining")

	void handle[Symbol.asyncDispose]().finally(() => process.exit(0))
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
