/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The batch API states `updated` as an ISO timestamp, and the latest job is the most recently updated entry with a
 *   `job` id.
 */

import { describe, expect, it } from "vitest"

import { latestOpenAddressesJob } from "#tools/fetch/openaddresses"

describe("latestOpenAddressesJob", () => {
	it("picks the most recently updated entry by its ISO timestamp, whatever order the API lists them in", () => {
		const entries = [
			{ source: "us/tx/nueces", job: 202_092, updated: "2021-12-31T10:00:00.000Z" },
			{ source: "us/tx/nueces", job: 944_001, updated: "2026-10-30T15:01:55.655Z" },
			{ source: "us/tx/nueces", job: 600_000, updated: "2024-03-01T00:00:00.000Z" },
		]

		expect(latestOpenAddressesJob(entries)?.job).toBe(944_001)
	})

	it("skips an entry that names no job, and answers undefined when none does", () => {
		expect(latestOpenAddressesJob([{ source: "us/ak/anchorage", updated: "2026-10-30T15:01:55.655Z" }])).toBeUndefined()
	})
})
