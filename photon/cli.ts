#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-photon` — boot a Photon-compatible autocomplete endpoint in one command. Run it with
 *   `npx @mailwoman/photon serve --port 2322 --data <gazetteer-or-bundle>`.
 *
 *   SCAFFOLD: wires {@link createPhotonRouter} with an EMPTY engine, so the server boots and `/api` +
 *   `/reverse` return `501` until the engine is wired (the Photon child of #801). Photon's default
 *   port is 2322, mirrored here. `--data` is parsed so the contract is fixed.
 */

import express from "express"
import { parseArgs } from "node:util"
import { createPhotonRouter, type PhotonEngine } from "./index.js"

function serve(): void {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "2322" },
			host: { type: "string", default: "0.0.0.0" },
			data: { type: "string" },
		},
		allowPositionals: true,
	})

	const port = Number(values.port) || 2322
	const host = values.host ?? "0.0.0.0"

	// TODO: construct the real engine from `values.data` — back `/api` with the FST autocomplete tier
	// (@mailwoman/resolver-wof-sqlite fst-autocomplete) + parse→resolve, and `/reverse` with
	// `WofReverseGeocoder`.
	const engine: PhotonEngine = {}

	const app = express()
	app.use(createPhotonRouter(engine))

	app.listen(port, host, () => {
		console.error(`[@mailwoman/photon] listening on http://${host}:${port}`)
		console.error(`  data root: ${values.data ?? "(unset — pass --data; engine wiring pending)"}`)
		console.error(`  endpoints: GET /api  GET /reverse`)
		console.error(`  NOTE: scaffold — endpoints return 501 until the engine is wired.`)
	})
}

const command = process.argv[2]

switch (command) {
	case "serve":
		serve()
		break
	default:
		console.error("Usage: mailwoman-photon serve [--port 2322] [--host 0.0.0.0] [--data <path>]")
		process.exit(command ? 1 : 0)
}
