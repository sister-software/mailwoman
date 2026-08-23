/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `fetchGeonamesPostal` — and specifically what it does with a country GeoNames does not publish.
 *
 *   That is the behaviour worth a test. GeoNames covers ~80 countries, not all of them, so a caller planning a postcode
 *   shard needs "this country does not exist upstream" kept apart from "the transfer failed" — the first is an
 *   acquisition question and the second is a retry. Venezuela is the live instance: it 404s, and it is the country the
 *   gauntlet evidence for the `«locality» «postcode»` defect comes from.
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { fetchGeonamesPostal } from "@mailwoman/corpus/tools"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let server: Server
let baseURL: string
let outRoot: string

/**
 * The manifest as written. `parseJSONStrict` rather than a tolerant parse: a corrupt manifest here is a test failure,
 * not a fallback.
 */
function readManifest(): { unavailable: string[]; files: Array<Record<string, unknown>>; [key: string]: unknown } {
	return parseJSONStrict(readFileSync(join(outRoot, "geonames-postal", "MANIFEST.json"), "utf8"))
}

beforeAll(async () => {
	server = createServer((req, res) => {
		// PT is published; VE is not. Anything else is a 500, so a transfer failure stays distinguishable from both.
		if (req.url === "/PT.zip") {
			res.writeHead(200)
			res.end("pt-payload")
		} else if (req.url === "/VE.zip") {
			res.writeHead(404)
			res.end("not found")
		} else {
			res.writeHead(500)
			res.end("boom")
		}
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})

	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	outRoot = mkdtempSync(join(tmpdir(), "mw-geonames-postal-"))
})

afterAll(() => {
	server.close()
})

describe("fetchGeonamesPostal", () => {
	it("records a 404 country as UNAVAILABLE and still fetches the rest", async () => {
		const summary = await fetchGeonamesPostal({ outRoot, baseURL, countries: ["pt", "ve"] })

		// One absent country must not cost the run — the whole point of naming several at once.
		expect(summary.fetched).toBe(1)
		expect(summary.failed).toBe(1)
		expect(summary.failedCodes).toEqual(["VE"])

		const manifest = readManifest()

		// The durable half: a later reader learns VE is not published without spending the fetch to rediscover it.
		expect(manifest.unavailable).toEqual(["VE"])
		expect(manifest.files).toHaveLength(1)

		const [pt] = manifest.files

		expect(pt?.country).toBe("PT")
		expect(pt?.bytes).toBe("pt-payload".length)
		expect(manifest.license).toBe("CC-BY-4.0")
		expect(manifest.attribution).toBe("GeoNames")
	})

	it("lower-cases input codes to the upper-case the source uses", async () => {
		const summary = await fetchGeonamesPostal({ outRoot, baseURL, countries: ["  pt  "] })

		expect(summary.fetched).toBe(1)
	})

	it("keeps a transfer failure OUT of `unavailable` — it is a retry, not a coverage gap", async () => {
		const summary = await fetchGeonamesPostal({ outRoot, baseURL, countries: ["ZZ"] })

		expect(summary.failedCodes).toEqual(["ZZ"])

		const manifest = readManifest()

		expect(manifest.unavailable).toEqual([])
	})
})
