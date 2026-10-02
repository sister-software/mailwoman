/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the live service, so the slow suite rather than the fast one.
 *
 *   `./emuia.test.ts` proves the harvester's decisions against stubbed bodies, and
 *   `#pl/adapters/emuia/adapter`'s suite proves the adapter against a fixture of captured bytes.
 *   Neither proves that a harvest of the real service writes a document that adapter reads.
 *
 *   The test takes one 25-feature page, which leaves the document unclosed. That is the state a
 *   partial harvest is in, and the adapter reading it is the claim worth proving.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { createEMUiAAdapter } from "#pl/adapters/emuia/adapter"
import { harvestEMUiAPL, PL_EMUIA_HARVEST_FILE } from "#pl/tools/fetch/emuia"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"

describe.runIf(LIVE_PUBLISHER_TESTS)("harvestEMUiAPL against the live service", () => {
	it("writes a GML document the adapter reads into rows", async () => {
		await using scratch = await temporaryDirectory("mailwoman-emuia-live-")
		await using client = new APIClient({ displayName: "pl-emuia" })

		const manifest = await harvestEMUiAPL(client, { outputDir: scratch.path, maxPages: 1, pageSize: 25 })

		// The service reports its 1,000-feature page cap as `numberMatched`, which is not a count.
		expect(manifest.feature_count).toBeNull()
		expect(manifest.feature_count_source).toMatch(/CountDefault|no usable count/u)
		expect(manifest.pages).toHaveLength(1)
		expect(manifest.pages[0]?.number_returned).toBe(25)
		expect(manifest.complete).toBe(false)

		const inputPath = PathBuilder.from(scratch.path)(PL_EMUIA_HARVEST_FILE)
		const rows = await Array.fromAsync(createEMUiAAdapter().rows({ inputPath }))

		expect(rows.length).toBeGreaterThan(15)
		expect(rows.every((row) => row.country === "PL")).toBe(true)
		expect(rows.every((row) => Boolean(row.components.locality))).toBe(true)
		expect(rows.every((row) => Boolean(row.components.house_number))).toBe(true)
	}, 600_000)
})
