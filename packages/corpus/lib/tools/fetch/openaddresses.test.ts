/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The batch API states `updated` as an ISO timestamp, and the latest job is the most recently updated entry with a
 *   `job` id.
 */

import { describe, expect, it } from "vitest"

import { latestMemberJob, latestOpenAddressesJob } from "#tools/fetch/openaddresses"

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

describe("latestMemberJob", () => {
	it("reads only the member's own jobs when the API also returns a member it prefixes", () => {
		// The API's answer for `source=us/fl/statewide`, in the shape it returned on 2026-11-10.
		const entries = [
			{ source: "us/fl/statewide", job: 905, updated: "2020-08-21T06:36:14.690Z" },
			{ source: "us/fl/statewide2", job: 313_650, updated: "2022-11-11T13:26:22.320Z" },
		]

		expect(latestMemberJob(entries, "us/fl/statewide")?.job).toBe(905)
		expect(latestMemberJob(entries, "us/fl/statewide2")?.job).toBe(313_650)
	})

	it("answers undefined when the API returns only other members' jobs", () => {
		expect(
			latestMemberJob(
				[{ source: "us/fl/orange_county", job: 98_751, updated: "2021-04-23T13:27:48.486Z" }],
				"us/fl/orange"
			)
		).toBeUndefined()
	})
})
