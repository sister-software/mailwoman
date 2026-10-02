/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the live service, so the slow suite rather than the fast one.
 *
 *   `./ads.test.ts` proves the harvester's decisions against stubbed bodies, and
 *   `#ee/adapters/ads/adapter`'s suite proves the adapter against a fixture of captured bytes.
 *   Neither proves that a harvest of the real service writes a file that adapter reads, which is the
 *   one claim captured bytes cannot make.
 *
 *   The test takes one 25-feature page. It does not skip when the service is unreachable: a test
 *   that passes on a failed request is indistinguishable from one that passed on an answer.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { createADSAdapter } from "#ee/adapters/ads/adapter"
import { EE_ADS_HARVEST_FILE, harvestADSEE } from "#ee/tools/fetch/ads"

describe("harvestADSEE against the live service", () => {
	it("writes a JSONL file the adapter reads into rows", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ads-live-")
		await using client = new APIClient({ displayName: "ee-ads" })

		const manifest = await harvestADSEE(client, { outputDir: scratch.path, maxPages: 1, pageSize: 25 })

		// Measured 729,973 on 2026-10-02.
		// The assertion is a lower bound rather than that number, because the register grows
		// and a pinned count would fail on ordinary progress.
		expect(manifest.feature_count).not.toBeNull()
		expect(manifest.feature_count ?? 0).toBeGreaterThan(700_000)
		expect(manifest.pages).toHaveLength(1)
		expect(manifest.pages[0]?.number_returned).toBe(25)
		expect(manifest.pages[0]?.number_matched).toBe(manifest.feature_count)
		expect(manifest.complete).toBe(false)

		const inputPath = PathBuilder.from(scratch.path)(EE_ADS_HARVEST_FILE)
		const rows = await Array.fromAsync(createADSAdapter().rows({ inputPath }))

		// Some of the 25 may be refused for a missing municipality or postcode,
		// so the bound is on what was read rather than on an exact yield.
		expect(rows.length).toBeGreaterThan(15)
		expect(rows.every((row) => row.country === "EE")).toBe(true)
		expect(rows.every((row) => Boolean(row.components.locality))).toBe(true)
		expect(rows.every((row) => row.license === "CC0-1.0")).toBe(true)

		// The defect the adapter exists to handle: the ADS code in the designator field never
		// reaches a house number, and an unused component slot never reaches a street.
		expect(rows.some((row) => /^\d+_/u.test(row.components.house_number ?? ""))).toBe(false)
		expect(rows.some((row) => row.components.street === "unpopulated")).toBe(false)
	}, 600_000)
})
