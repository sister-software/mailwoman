/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Container entrypoint for the `ghcr.io/sister-software/mailwoman` image — a batteries-included
 *   native `/v1` HTTP API (parse, geocode, batch, format, health, metrics) over the PUBLISHED
 *   `@mailwoman/*` npm packages baked into the image. This is deliberately NOT the `mailwoman serve`
 *   CLI: that command's `createServeEngine` exits(1) when no gazetteer is on disk (a supervisor-must-
 *   see-nonzero policy that suits a hand-run server), which would defeat the container's first-run
 *   story. Here the caller (this file) chooses the other branch the engine builder documents — "boot
 *   degraded (parse+health only)" — so `docker run` with no data volume still answers `/v1/parse`.
 *
 *   The wiring MIRRORS `mailwoman/api-engine.ts` (`createServeEngine`) using only that package's own
 *   exported building blocks — `mailwoman/geocode-core` (`geocodeAddress`, `RegionDatabaseProvider`) and
 *   `mailwoman/resolver-backend` (`createResolverBackend`, `resolveCandidateDBPath`, `wofExtractPaths`,
 *   `mailwomanDataRoot`) — so the geocode path does not drift from the real server. Model WEIGHTS ship
 *   IN the image via `@mailwoman/neural-weights-en-us`; the gazetteer / resolver DBs are volume-mounted
 *   read-only at `$MAILWOMAN_DATA_ROOT` (the image sets it to `/data`).
 *
 *   Boot policy:
 *     - `parse` + `health` are ALWAYS wired (weights-only, no gazetteer needed).
 *     - `geocode` + `batch` are wired ONLY when a gazetteer is resolvable (a candidate.db under
 *       `$MAILWOMAN_DATA_ROOT/wof`, an explicit `$MAILWOMAN_CANDIDATE_DB`, or FTS admin extracts via
 *       `$MAILWOMAN_WOF_DB` / the conventional `wof/` extract paths). Absent → `@mailwoman/api` answers
 *       `503` on `/v1/geocode` + `/v1/batch` (a clean degrade, not a crash).
 *     - When the weights themselves are unresolvable, `parse` is absent and `/v1/parse` answers `501`.
 *
 *   The container always listens on port 3000 on 0.0.0.0; remap with `docker run -p <host>:3000`. The
 *   drop-in servers (`@mailwoman/nominatim`, `@mailwoman/photon`, `@mailwoman/libpostal`) are also in
 *   the image and can be run as alternative commands — see `docker/README.md`.
 */

import { createMailwomanAPI } from "@mailwoman/api"
import type { MailwomanAPIEngine, GeocodeCallback, GeocodeOutcomeLike, BatchResultEntry } from "@mailwoman/api"
import { serveNode } from "@mailwoman/api-kit"
import { decodeAsTuples, decodeAsXML } from "@mailwoman/core"
import { $public } from "@mailwoman/core/env"
import { pathExists } from "@mailwoman/core/fs/readers"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { geocodeAddress, RegionDatabaseProvider } from "mailwoman/geocode"
import {
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	resolveWOFDatabasePaths,
} from "mailwoman/resolver-backend"
import { AsyncSequence } from "spliterator"

const PORT = 3000
const HOST = "0.0.0.0"
const DATA_ROOT = mailwomanDataRoot()

/**
 * The WOF extract set to attach: {@link resolveWOFDatabasePaths} selects it (the `$MAILWOMAN_WOF_DB` comma-separated
 * override, else the conventional per-extract `wof/` paths). An explicit list is the operator's statement and passes
 * through unfiltered; the conventional set is probed, so a deployment missing a extract degrades to what is present.
 */
function wofPaths(): Promise<string[]> {
	const paths = resolveWOFDatabasePaths()

	if ($public.MAILWOMAN_WOF_DB) return Promise.resolve(paths)

	return AsyncSequence.from(paths).parallelFilter(pathExists).toArray()
}

/**
 * Build the wired engine. `parse` + `health` always; `geocode` + `batch` only when a gazetteer resolves.
 */
async function buildEngine<T extends GeocodeOutcomeLike = GeocodeOutcomeLike>() {
	const engine: MailwomanAPIEngine<T> = {
		health: async () => ({
			data: {
				data_root: DATA_ROOT,
			},
		}),
	}

	// Parse needs only the model weights (baked in via @mailwoman/neural-weights-en-us). Load them in
	// their OWN try so a later gazetteer failure can never disable /v1/parse — the two are independent.
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
			// Weights unresolvable — leave parse undefined; /v1/parse answers 501 with its existing guard.
			console.error(`[mailwoman] neural weights not found — /v1/parse disabled (501): ${error}`)

			return null
		})

	// Geocode/batch need both the weights (for the parse step) AND a gazetteer. A missing/unopenable
	// gazetteer leaves these methods undefined so @mailwoman/api answers 503 (the clean degrade) — and,
	// in its own try, never takes parse down with it.
	if (classifier) {
		const candidateDB = await resolveCandidateDBPath()
		const paths = await wofPaths()

		if (candidateDB || paths.length) {
			try {
				const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
				const backend = await createResolverBackend(resolverMod, { wofPaths: paths })
				const resolver = createWOFResolver(backend)
				const extracts = await RegionDatabaseProvider.create(resolverMod, DATA_ROOT)
				// Candidate backend → country-agnostic (population-first, demo parity); FTS backend keeps US.
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
				// Gazetteer present but unopenable (e.g. a WAL-mode DB on a read-only mount). Degrade to
				// parse-only rather than crash; /v1/geocode + /v1/batch answer 503.
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
