// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A server the `mwops probe` tests start as a child process, in the shape of a workspace server:
 * it takes `--host` and `--port`, and prints `listening on http://<host>:<bound port>` once bound.
 *
 * The first argument chooses its behavior:
 *
 * - `listen` answers `/json` with a JSON body, `/large` with 5000 bytes of text, and `/fail` with a 500.
 * - `stubborn` does the same and ignores SIGTERM, so only SIGKILL stops it.
 * - `exit-early` prints an error and exits with status 3 before it listens.
 * - `silent` stays running with empty output and never listens.
 */

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { parseArgs } from "node:util"

const { positionals, values } = parseArgs({
	options: { host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "0" } },
	allowPositionals: true,
})

const mode = positionals[0]

if (mode === "exit-early") {
	process.stderr.write("Error: no such table: layer_manifest\n")
	process.exit(3)
}

if (mode === "silent") {
	setInterval(() => {}, 60_000)
} else {
	if (mode === "stubborn") {
		process.on("SIGTERM", () => {})
	}

	const server = createServer((request, response) => {
		if (request.url === "/json") {
			response.writeHead(200, { "content-type": "application/json" })
			response.end('{"conformsTo":["a","b"],"meta":{"count":2}}')
		} else if (request.url === "/large") {
			response.writeHead(200, { "content-type": "text/plain" })
			response.end("x".repeat(5000))
		} else if (request.url === "/fail") {
			response.writeHead(500, { "content-type": "text/plain" })
			response.end("internal error")
		} else {
			response.writeHead(404, { "content-type": "text/plain" })
			response.end("not found")
		}
	})

	server.listen(Number(values.port), values.host, () => {
		process.stderr.write(`[fixture] listening on http://${values.host}:${(server.address() as AddressInfo).port}\n`)
	})
}
