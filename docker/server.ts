/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Container entrypoint that serves the `/v1` API on `0.0.0.0:3000`.
 *
 *   Parsing needs the bundled English weights and returns `501` without them. Geocoding and batch
 *   also need a gazetteer mounted at `$MAILWOMAN_DATA_ROOT` and return `503` without one.
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
 * Resolve the WOF extract paths.
 *
 * An explicit `$MAILWOMAN_WOF_DB` list is returned unchanged.
 * Default paths are filtered to files that exist.
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

	// Weights load separately so that a gazetteer failure leaves parsing available.
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
			console.error(`[mailwoman] neural weights not found — /v1/parse disabled (501): ${error}`)

			return null
		})

	if (classifier) {
		const candidateDB = await resolveCandidateDBPath()
		const paths = await wofPaths()

		if (candidateDB || paths.length) {
			try {
				const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
				const backend = await createResolverBackend(resolverMod, { wofPaths: paths })
				const resolver = createWOFResolver(backend)
				const extracts = await RegionDatabaseProvider.create(resolverMod, DATA_ROOT)
				// The candidate database covers every country.
				// The FTS backend falls back to US.
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
