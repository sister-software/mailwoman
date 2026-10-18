/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

// oxlint-disable-next-line no-restricted-imports -- Core has no HTTP server wrapper. This fixture only binds loopback.
import { createServer } from "node:http"

import { once } from "@mailwoman/core/utils/events"

/**
 * Serves a local page that records browser properties before any interaction.
 */
export async function serveBrowserFixture() {
	const server = createServer((request, response) => {
		if (request.url === "/download") {
			response.writeHead(200, {
				"content-type": "text/csv",
				"content-disposition": 'attachment; filename="addresses.csv"',
			})

			response.end("address\n10 Downing Street, London SW1A 2AA\n")

			return
		}

		response.writeHead(200, { "content-type": "text/html" })

		response.end(`<!doctype html><title>Browser fixture</title>
			<script>globalThis.initialWebdriver = navigator.webdriver;</script>
			<h1>Browser fixture</h1><a href="/download">Download addresses</a>
			${request.url === "/" ? '<iframe src="/frame"></iframe>' : ""}`)
	})

	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const address = server.address()

	if (!address || typeof address === "string") throw new Error("The fixture has no TCP address.")

	return {
		url: `http://127.0.0.1:${address.port}/`,
		[Symbol.asyncDispose]: () => server[Symbol.asyncDispose](),
	}
}
