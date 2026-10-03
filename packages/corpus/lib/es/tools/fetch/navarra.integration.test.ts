/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the live service, so the slow suite rather than the fast one.
 *
 *   `./navarra.test.ts` proves the harvest's decisions against stubbed bodies, and
 *   `#es/adapters/navarra/adapter`'s suite proves the adapter against captured bytes. Neither
 *   proves that a harvest of the real service writes a directory that adapter reads, which is the
 *   one claim captured bytes cannot make.
 *
 *   The bounded run takes the first two partitions, which is three requests. It does not skip when
 *   the service is unreachable: a test that passes on a failed request is indistinguishable from
 *   one that passed on an answer.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import { createESNavarraAdapter } from "#es/adapters/navarra/adapter"
import { type ESNavarraHarvestManifest, harvestESNavarra } from "#es/tools/fetch/navarra"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"
import { readManifest } from "#tools/fetch/download"

describe.runIf(LIVE_PUBLISHER_TESTS)("harvestESNavarra against the live service", () => {
	it("harvests two partitions into a directory the adapter reads into rows", async () => {
		await using scratch = await temporaryDirectory("mailwoman-navarra-live-")
		await using client = new APIClient({ displayName: "es-navarra", minRequestIntervalMs: 250 })

		const summary = await harvestESNavarra(client, { outputDir: scratch.path, limit: 2 })

		expect(summary).toMatchObject({ fetched: 2, skipped: 0, failed: 0 })

		const manifest = await readManifest<ESNavarraHarvestManifest>(scratch.path("MANIFEST.json"))

		// The register recorded 272 partitions on 2026-09-30.
		// The assertion is a lower bound rather than that number, because the publisher
		// re-partitions the province and a pinned count would fail on ordinary progress.
		expect(manifest?.partitions_listed).toBeGreaterThanOrEqual(200)
		expect(manifest?.license).toBe("CC-BY-4.0")

		const [first] = manifest?.files ?? []

		expect(first?.filename).toBe("AD_Navarra_1.gml.zip")
		expect(first?.partition).toBe("1")
		expect(first?.bytes).toBeGreaterThan(1000)
		expect(first?.sha256).toMatch(/^[0-9a-f]{64}$/u)

		// Every entry claims 34,987 bytes, and partition 1 delivered 7,476 on 2026-10-03,
		// so the recorded count is the delivered body rather than the claim.
		expect(first?.bytes).not.toBe(34_987)

		const rows = await Array.fromAsync(createESNavarraAdapter().rows({ inputPath: scratch.path, limit: 50 }))

		expect(rows).toHaveLength(50)
		expect(rows.every((row) => row.country === "ES")).toBe(true)
		expect(rows.every((row) => Boolean(row.components.street))).toBe(true)
		expect(rows.every((row) => Boolean(row.components.locality))).toBe(true)
	}, 600_000)
})
