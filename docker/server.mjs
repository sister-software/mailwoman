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
 *   exported building blocks — `mailwoman/geocode-core` (`geocodeAddress`, `ShardProvider`) and
 *   `mailwoman/resolver-backend` (`createResolverBackend`, `resolveCandidateDBPath`, `wofShardPaths`,
 *   `mailwomanDataRoot`) — so the geocode path does not drift from the real server. Model WEIGHTS ship
 *   IN the image via `@mailwoman/neural-weights-en-us`; the gazetteer / resolver DBs are volume-mounted
 *   read-only at `$MAILWOMAN_DATA_ROOT` (the image sets it to `/data`).
 *
 *   Boot policy:
 *     - `parse` + `health` are ALWAYS wired (weights-only, no gazetteer needed).
 *     - `geocode` + `batch` are wired ONLY when a gazetteer is resolvable (a candidate.db under
 *       `$MAILWOMAN_DATA_ROOT/wof`, an explicit `$MAILWOMAN_CANDIDATE_DB`, or FTS admin shards via
 *       `$MAILWOMAN_WOF_DB` / the conventional `wof/` shard paths). Absent → `@mailwoman/api` answers
 *       `503` on `/v1/geocode` + `/v1/batch` (a clean degrade, not a crash).
 *     - When the weights themselves are unresolvable, `parse` is absent and `/v1/parse` answers `501`.
 *
 *   The container always listens on port 3000 on 0.0.0.0; remap with `docker run -p <host>:3000`. The
 *   drop-in servers (`@mailwoman/nominatim`, `@mailwoman/photon`, `@mailwoman/libpostal`) are also in
 *   the image and can be run as alternative commands — see `docker/README.md`.
 */

import { existsSync } from "node:fs"

import { createMailwomanAPI } from "@mailwoman/api"
import { serveNode } from "@mailwoman/api-kit"
import { decodeAsTuples, decodeAsXML } from "@mailwoman/core"
import { $public } from "@mailwoman/core/env"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import {
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"

const PORT = 3000
const HOST = "0.0.0.0"
const DATA_ROOT = mailwomanDataRoot()

/**
 * Same WOF-path resolution as `mailwoman/api-engine.ts`: the `$MAILWOMAN_WOF_DB` comma-separated override, else the
 * conventional per-shard `wof/` paths that actually exist on disk.
 */
function wofPaths() {
	const env = $public.MAILWOMAN_WOF_DB

	if (env) {
		return env
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)
	}

	return wofShardPaths().filter((p) => existsSync(p))
}

/** Build the wired engine. `parse` + `health` always; `geocode` + `batch` only when a gazetteer resolves. */
async function buildEngine() {
	/** @type {import("@mailwoman/api").MailwomanAPIEngine} */
	const engine = {
		health: () => ({
			data: {
				data_root: DATA_ROOT,
			},
		}),
	}

	// Parse needs only the model weights (baked in via @mailwoman/neural-weights-en-us). Load them in
	// their OWN try so a later gazetteer failure can never disable /v1/parse — the two are independent.
	let classifier

	try {
		classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

		engine.parse = async (address, opts) => {
			const tree = await classifier.parse(address, { postcodeRepair: true })

			return {
				input: address,
				components: decodeAsTuples(tree).map(([tag, value]) => ({ tag, value })),
				tree,
				debug: opts.debug ? decodeAsXML(tree) : undefined,
			}
		}
	} catch (error) {
		// Weights unresolvable — leave parse undefined; /v1/parse answers 501 with its existing guard.
		console.error(`[mailwoman] neural weights not found — /v1/parse disabled (501): ${error}`)
	}

	// Geocode/batch need both the weights (for the parse step) AND a gazetteer. A missing/unopenable
	// gazetteer leaves these methods undefined so @mailwoman/api answers 503 (the clean degrade) — and,
	// in its own try, never takes parse down with it.
	if (classifier) {
		const candidateDb = resolveCandidateDBPath()
		const paths = wofPaths()

		if (candidateDb || paths.length > 0) {
			try {
				const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
				const backend = createResolverBackend(resolverMod, { wofPaths: paths })
				const resolver = createWOFResolver(backend)
				const shards = new ShardProvider(resolverMod, DATA_ROOT)
				// Candidate backend → country-agnostic (population-first, demo parity); FTS backend keeps US.
				const defaultCountry = candidateDb ? undefined : "US"

				const oneGeocode = (address) =>
					geocodeAddress(address, { classifier, resolver, shards: shards.for, defaultCountry })

				engine.geocode = async (address) => oneGeocode(address)

				engine.batch = async (addresses) => {
					const inputs = addresses.map((a) => a.trim())
					const results = new Array(inputs.length)

					for (let i = 0; i < inputs.length; i++) {
						const input = inputs[i]

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

const handle = serveNode({
	fetch: app.fetch,
	port: PORT,
	hostname: HOST,
	onListen: ({ port, address }) => console.error(`[mailwoman] native /v1 API listening on http://${address}:${port}`),
})

let draining = false

const shutdown = () => {
	if (draining) return
	draining = true
	console.error("[mailwoman] draining")
	void handle.close().finally(() => process.exit(0))
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
