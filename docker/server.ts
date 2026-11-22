// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Container entrypoint that serves the `/v1` API on `0.0.0.0:3000`.
 *
 *   The engine is the one `mailwoman serve` builds: `createServeEngine` composes
 *   a geocode session and the routes read it.
 *   The API parser needs the bundled English weights and returns `501` when they're absent.
 *
 *   The geocode and batch endpoints also need a gazetteer mounted at `$MAILWOMAN_DATA_ROOT`
 *   and return `503` when no gazetteer is available.
 */

import { createMailwomanAPI } from "@mailwoman/api"
import { serveNode } from "@mailwoman/api-kit"
import { dataRootPath } from "@mailwoman/core/data-root"
import { createServeEngine } from "mailwoman/api-engine"
import { $public } from "mailwoman/env"
import { resolveCandidateDBPath } from "mailwoman/resolver-backend"

const PORT = 3000
const HOST = "0.0.0.0"
const DATA_ROOT = dataRootPath()

const candidateDB = await resolveCandidateDBPath()

// country-branch: the candidate gazetteer covers every country, and without it the
// session reads the WOF admin extracts under a caller scope of US.
// The countries an extract's own manifest states would replace the literal.
const extractScope = candidateDB ? {} : { defaultCountry: "US" }

// The image answers queries from every country, so the session reads zero country scope off its locale.
const serveEngine = await createServeEngine({ countryScope: "none", ...extractScope })

if (serveEngine.preflight.ok) {
	console.error(`[mailwoman] gazetteer found — /v1/geocode + /v1/batch enabled (data root: ${DATA_ROOT})`)
} else if (serveEngine.engine.parse) {
	console.error(
		`[mailwoman] no gazetteer at ${DATA_ROOT} — booting parse-only (/v1/geocode + /v1/batch answer 503).\n` +
			`[mailwoman] mount one read-only to enable geocoding: docker run -v <host-data>:/data:ro …`
	)
}

// The image serves the routes its README lists: parse, geocode, batch and health.
// The engine's tree-resolve and reload operations stay unrouted here.
const { parse, geocode, batch, health } = serveEngine.engine

const app = createMailwomanAPI(
	{ health, ...(parse ? { parse } : {}), ...(geocode ? { geocode } : {}), ...(batch ? { batch } : {}) },
	{ batchMax: Math.max(1, $public.MAILWOMAN_BATCH_MAX) }
)

// The handle lives as long as the process.
// A `using` binding at module scope would dispose it, and close the server,
// as soon as this module finished evaluating.
// `shutdown` disposes it instead, and then the engine's session and classifier.
const handle = await serveNode({
	fetch: app.fetch,
	port: PORT,
	hostname: HOST,
})

let draining = false

const shutdown = () => {
	if (draining) return
	draining = true

	console.error("[mailwoman] draining")

	void handle[Symbol.asyncDispose]()
		.then(() => serveEngine[Symbol.asyncDispose]())
		.finally(() => process.exit(0))
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
