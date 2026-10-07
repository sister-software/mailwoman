/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the live service, so the slow suite rather than the fast one.
 *
 *   `./catastro.test.ts` proves the harvest's decisions against stubbed bodies, and
 *   `#es/adapters/catastro/adapter`'s suite proves the adapter against captured bytes. Neither
 *   proves that a harvest of the real service writes a directory that adapter reads. That is the
 *   one claim captured bytes cannot make.
 *
 *   The bounded run takes Ceuta. Ceuta is one municipality in one province feed, so the run makes
 *   three requests. It does not skip when the service is unreachable: a test that passes on a failed
 *   request is indistinguishable from one that passed on an answer.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import { createESCatastroAdapter } from "#es/adapters/catastro/adapter"
import {
	decodeDeclaredXML,
	ES_CATASTRO_SERVICE_FEED_URL,
	type ESCatastroHarvestManifest,
	harvestESCatastro,
	readESCatastroServiceFeed,
} from "#es/tools/fetch/catastro"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"
import { feedChunks, readAtomFeed } from "#tools/fetch/atom"
import { readManifest } from "#tools/fetch/download"

/**
 * The province whose feed lists exactly one municipality.
 *
 * That makes a bounded live harvest three requests rather than a national one.
 */
const CEUTA = "55"

describe.runIf(LIVE_PUBLISHER_TESTS)("harvestESCatastro against the live service", () => {
	it("harvests Ceuta into a directory the adapter reads into rows", async () => {
		await using scratch = await temporaryDirectory("mailwoman-catastro-live-")
		await using client = new APIClient({ displayName: "es-catastro", minRequestIntervalMs: 250 })

		const summary = await harvestESCatastro(client, { outputDir: scratch.path, provinces: [CEUTA] })

		expect(summary).toMatchObject({ fetched: 1, skipped: 0, failed: 0 })

		const manifest = await readManifest<ESCatastroHarvestManifest>(scratch.path("MANIFEST.json"))

		// The register recorded 52 territorial offices of 55 entries on 2026-09-30.
		// The assertion is a lower bound rather than that number, because the publisher merges
		// and adds offices and a pinned count would fail on ordinary progress.
		expect(manifest?.provinces_listed).toBeGreaterThanOrEqual(50)
		expect(manifest?.provinces_harvested).toBe(1)
		expect(manifest?.municipalities_listed).toBe(1)

		const [file] = manifest?.files ?? []

		expect(file?.filename).toBe("A.ES.SDGC.AD.55101.zip")
		expect(file?.municipality_code).toBe("55101")
		expect(file?.province_code).toBe(CEUTA)
		expect(file?.bytes).toBeGreaterThan(100_000)
		expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/u)

		const rows = await Array.fromAsync(createESCatastroAdapter().rows({ inputPath: scratch.path, limit: 50 }))

		expect(rows).toHaveLength(50)
		expect(rows.every((row) => row.country === "ES")).toBe(true)
		expect(rows.every((row) => Boolean(row.components.street))).toBe(true)
		expect(rows.some((row) => row.components.locality === "CEUTA")).toBe(true)
	}, 600_000)

	it("selects every territorial office and leaves only the foral cadastres out", async () => {
		await using client = new APIClient({ displayName: "es-catastro" })

		const { data } = await client.fetch<ArrayBuffer>({
			method: "GET",
			url: ES_CATASTRO_SERVICE_FEED_URL,
			responseType: "arraybuffer",
		})

		const feed = await readAtomFeed(feedChunks(decodeDeclaredXML(Buffer.from(data))))
		const provinces = readESCatastroServiceFeed(feed)
		const selected = new Set(provinces.map((province) => province.title))

		// The invariant rather than a count: every entry the reader leaves out is a foral cadastre.
		// Each has its own register row, license and adapter.
		expect(feed.entries.map((entry) => entry.title.trim()).filter((title) => !selected.has(title))).toSatisfy(
			(titles: readonly string[]) => titles.every((title) => title.startsWith("Provincial Council of"))
		)

		expect(provinces.map((province) => province.code)).toContain(CEUTA)
	}, 120_000)
})
