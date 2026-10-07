/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the live service, so the slow suite rather than the fast one.
 *
 *   `./vlaanderen-ad.test.ts` proves the harvester's decisions against stubbed bodies, and
 *   `#be/adapters/vlaanderen/adapter`'s suite proves the adapter against a fixture of captured
 *   bytes. Neither proves that a harvest of the real service produces a directory that adapter
 *   reads. That is the one claim captured bytes cannot establish.
 *
 *   The test takes one 25-address page and the component types whole. It does not skip when the
 *   service is unreachable: a test that passes on a failed request is indistinguishable from one
 *   that passed on an answer.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import { createVlaanderenAdapter } from "#be/adapters/vlaanderen/adapter"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"
import { harvestVlaanderenAD, MAX_PAGE_SIZE } from "#tools/fetch/vlaanderen-ad"

describe.runIf(LIVE_PUBLISHER_TESTS)("harvestVlaanderenAD against the live service", () => {
	it("writes a harvest the adapter reads into rows", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vlaanderen-live-")

		await using client = new APIClient({ displayName: "vlaanderen-ad" })
		const harvest = await harvestVlaanderenAD(client, { outputDir: scratch.path, maxPages: 1, pageSize: 25 })

		// Measured 4,563,062 on 2026-10-02.
		// The assertion is a lower bound rather than that number, because the register grows
		// and a pinned count would fail on ordinary progress.
		expect(harvest.addressCount).toBeGreaterThan(4_000_000)

		// 167,218 thoroughfare names at a 10,000 cap is 17 pages, so this type proves the paging.
		expect(harvest.components.ThoroughfareName.length).toBeGreaterThan(1)
		expect(harvest.components.PostalDescriptor.length).toBeGreaterThanOrEqual(1)
		expect(harvest.components.AdminUnitName.length).toBeGreaterThanOrEqual(1)
		expect(harvest.addressPages).toHaveLength(1)
		expect(harvest.addressPages[0]?.numberReturned).toBe(25)

		const rows = await Array.fromAsync(createVlaanderenAdapter().rows({ inputPath: scratch.path }))

		// Some of the 25 may be refused for a lost character, so the bound is on what
		// was read rather than on an exact yield.
		expect(rows.length).toBeGreaterThan(15)
		expect(rows.every((row) => row.country === "BE")).toBe(true)
		expect(rows.every((row) => Boolean(row.components.street))).toBe(true)
		expect(rows.every((row) => Boolean(row.components.postcode))).toBe(true)
		expect(rows.every((row) => Boolean(row.components.locality))).toBe(true)

		// The three defects this adapter exists to handle, asserted over live rows.
		expect(rows.some((row) => row.raw.includes("?"))).toBe(false)
		expect(rows.some((row) => row.raw.endsWith("_"))).toBe(false)
		expect(rows.some((row) => row.components.street?.includes("_"))).toBe(false)
		expect(rows.some((row) => row.components.locality === "België")).toBe(false)
	}, 600_000)

	it("pages at the size the service serves", () => {
		expect(MAX_PAGE_SIZE).toBe(10_000)
	})
})
