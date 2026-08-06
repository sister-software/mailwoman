// A minimal geocoding server for the example Dockerfile: node:http, no framework, three routes.
//
// The classifier, the gazetteer handle and the resolver are built once at module scope. That is the
// whole performance story of a container deploy — the model load is the expensive part and it is paid
// once per process, not once per request.
import { createServer } from "node:http"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { geocodeAddress } from "mailwoman/geocode-core"
import { resolveCandidateDBPath } from "mailwoman/resolver-backend"

// This file is served at /examples/mailwoman-server.mjs and runs in a READER's project, where
// `@mailwoman/core/env` — the blessed env helper inside this repo — is not a dependency. A raw read is
// the correct shape here, and it is the only one in the file: the gazetteer path below goes through
// `resolveCandidateDBPath`, which IS reachable from a reader's install.
// oxlint-disable-next-line sister-software/no-process-globals -- shipped doc asset; runs outside this repo
const PORT = Number(process.env.PORT ?? 3000)

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

// Geocoding is opt-in on a gazetteer being THERE, not on anything being configured.
// `resolveCandidateDBPath` is the shipped helper for exactly this: it tries an explicit path, then
// `$MAILWOMAN_CANDIDATE_DB`, then `<data-root>/wof/candidate.db`, and returns undefined unless one of
// them is a file that exists. That last position is why an image needs only its volume mount, and the
// existence check is why a first run WITHOUT one still boots: a truthiness check on the variable would
// open a file that is not there and kill the process with SQLITE_CANTOPEN before it bound a port.
// Same guard the published image's server.mjs uses.
const candidateDB = resolveCandidateDBPath()

let resolver

if (candidateDB) {
	resolver = createWOFResolver(new WOFCandidateTableLookup({ databasePath: candidateDB }))
}

function send(res, status, body) {
	const json = JSON.stringify(body)

	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) })
	res.end(json)
}

createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`)
	const address = url.searchParams.get("address")

	try {
		if (url.pathname === "/health") return send(res, 200, { ok: true, geocoder: Boolean(resolver) })

		if (!address) return send(res, 400, { error: "missing ?address=" })

		if (url.pathname === "/parse") {
			return send(res, 200, await classifier.parse(address, { postcodeRepair: true }))
		}

		if (url.pathname === "/geocode") {
			if (!resolver) return send(res, 503, { error: "no gazetteer found — mount one at <data-root>/wof/candidate.db" })

			return send(res, 200, await geocodeAddress(address, { classifier, resolver, defaultCountry: "US" }))
		}

		send(res, 404, { error: "not found" })
	} catch (error) {
		send(res, 500, { error: error instanceof Error ? error.message : String(error) })
	}
}).listen(PORT, "0.0.0.0", () => {
	console.error(`listening on http://0.0.0.0:${PORT} (geocoder: ${resolver ? "ready" : "off"})`)
})
