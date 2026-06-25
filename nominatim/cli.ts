#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-nominatim` — boot a Nominatim-compatible endpoint via the `serve` command. Usage +
 *   examples live in the package README.
 *
 *   SCAFFOLD: this wires {@link createNominatimRouter} with an EMPTY engine, so the server boots and
 *   answers `/status` (OK) while `/search` + `/reverse` return `501`. Wiring the real Mailwoman
 *   engine (parse → resolve via the `mailwoman` runtime pipeline + `WofReverseGeocoder` from
 *   `@mailwoman/resolver-wof-sqlite`) is #809; `--data` is parsed here so the contract is fixed.
 */

import express from "express"
import { parseArgs } from "node:util"
import { createNominatimRouter, type NominatimEngine } from "./index.js"

function serve(): void {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "8080" },
			host: { type: "string", default: "0.0.0.0" },
			data: { type: "string" },
		},
		allowPositionals: true,
	})

	const port = Number(values.port) || 8080
	const host = values.host ?? "0.0.0.0"

	// TODO(#809): construct the real engine from `values.data`:
	//   const backend = createResolverBackend(...)        // @mailwoman/resolver-wof-sqlite
	//   const reverse  = new WofReverseGeocoder(...)
	//   const engine: NominatimEngine = { search, reverse, lookup, status }
	const engine: NominatimEngine = {
		status: async () => ({ status: 0, message: "OK", data_updated: undefined }),
	}

	const app = express()
	app.use(createNominatimRouter(engine))

	app.listen(port, host, () => {
		console.error(`[@mailwoman/nominatim] listening on http://${host}:${port}`)
		console.error(`  data root: ${values.data ?? "(unset — pass --data; engine wiring is #809)"}`)
		console.error(`  endpoints: GET /search  GET /reverse  GET /lookup  GET /status`)
		console.error(`  NOTE: scaffold — /search + /reverse return 501 until #802/#803 land.`)
	})
}

const command = process.argv[2]

switch (command) {
	case "serve":
		serve()
		break
	default:
		console.error("Usage: mailwoman-nominatim serve [--port 8080] [--host 0.0.0.0] [--data <path>]")
		process.exit(command ? 1 : 0)
}
