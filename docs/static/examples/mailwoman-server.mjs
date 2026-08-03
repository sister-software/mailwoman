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

const PORT = Number(process.env.PORT ?? 3000)
const CANDIDATE_DB = process.env.MAILWOMAN_CANDIDATE_DB

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

// Geocoding is opt-in on the presence of a gazetteer. With no volume mounted, /parse still answers and
// /geocode reports 503 — the same degrade the published image makes, so a first run needs no data.
let resolver

if (CANDIDATE_DB) {
	resolver = createWOFResolver(new WOFCandidateTableLookup({ databasePath: CANDIDATE_DB }))
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
			if (!resolver) return send(res, 503, { error: "no gazetteer mounted at $MAILWOMAN_CANDIDATE_DB" })

			return send(res, 200, await geocodeAddress(address, { classifier, resolver, defaultCountry: "US" }))
		}

		send(res, 404, { error: "not found" })
	} catch (error) {
		send(res, 500, { error: error instanceof Error ? error.message : String(error) })
	}
}).listen(PORT, "0.0.0.0", () => {
	console.error(`listening on http://0.0.0.0:${PORT} (geocoder: ${resolver ? "ready" : "off"})`)
})
