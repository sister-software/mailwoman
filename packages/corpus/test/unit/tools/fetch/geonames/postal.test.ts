/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `fetchGeonamesPostal` — and specifically what it does with a country GeoNames does not publish.
 *
 *   That is the behaviour worth a test. GeoNames covers ~80 countries, not all of them, so a caller planning a postcode
 *   slice needs "this country does not exist upstream" kept apart from "the transfer failed" — the first is an
 *   acquisition question and the second is a retry. Venezuela is the live instance: it 404s and the country the
 *   gauntlet evidence for the `«locality» «postcode»` defect comes from.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { fetchGeonamesPostal } from "@mailwoman/corpus/tools"
import { join, type PathBuilderLike } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

let server: Server
let baseURL: string
let outRoot: PathBuilderLike

/**
 * The manifest as written. `parseJSONStrict` rather than a tolerant parse: a corrupt manifest here is a test failure,
 * not a fallback.
 */
async function readManifest(): Promise<{
	unavailable: string[]
	files: Array<Record<string, unknown>>
	[key: string]: unknown
}> {
	return await readLocalJSONFile(join(outRoot, "geonames-postal", "MANIFEST.json"))
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
		} else if (req.url === "/v404/ZZ.zip") {
			// The regression route: a 500 whose URL contains the substring "404". CI drew an ephemeral server
			// port containing "404" and the prose-matching classifier filed a transfer failure as "GeoNames
			// does not publish this country". The path plants the same substring deterministically.
			res.writeHead(500)
			res.end("boom")
		} else {
			res.writeHead(500)
			res.end("boom")
		}
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})

	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	outRoot = fixtures.use(await temporaryDirectory("mw-geonames-postal-")).path
})

afterAll(() => server[Symbol.asyncDispose]())

/**
 * The retry COUNT is what these cases pin; the pause between attempts is not, and paying the shipped 5 s twice per
 * failing transfer cost this file 20.1 s of the fast leg.
 */
const RETRY_DELAY_MS = 1

describe("fetchGeonamesPostal", () => {
	it("records a 404 country as UNAVAILABLE and still fetches the rest", async () => {
		const summary = await fetchGeonamesPostal({
			retryDelayMs: RETRY_DELAY_MS,
			outRoot,
			baseURL,
			countries: ["pt", "ve"],
		})

		// One absent country must not cost the run — the whole point of naming several at once.
		expect(summary.fetched).toBe(1)
		expect(summary.failed).toBe(1)
		expect(summary.failedCodes).toEqual(["VE"])

		const manifest = await readManifest()

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
		const summary = await fetchGeonamesPostal({ retryDelayMs: RETRY_DELAY_MS, outRoot, baseURL, countries: ["  pt  "] })

		expect(summary.fetched).toBe(1)
	})

	it("classifies by STATUS, not by message prose — a 500 from a URL containing '404' stays a transfer failure", async () => {
		// ~1-2% of ephemeral ports contain the substring "404"; this pins the failure mode with the substring in
		// the path instead, where it is deterministic.
		const summary = await fetchGeonamesPostal({
			retryDelayMs: RETRY_DELAY_MS,
			outRoot,
			baseURL: `${baseURL}/v404`,
			countries: ["ZZ"],
		})

		expect(summary.failedCodes).toEqual(["ZZ"])
		expect((await readManifest()).unavailable).toEqual([])
	})

	it("keeps a transfer failure OUT of `unavailable` — it is a retry, not a coverage gap", async () => {
		const summary = await fetchGeonamesPostal({ retryDelayMs: RETRY_DELAY_MS, outRoot, baseURL, countries: ["ZZ"] })

		expect(summary.failedCodes).toEqual(["ZZ"])

		const manifest = await readManifest()

		expect(manifest.unavailable).toEqual([])
	})
})
