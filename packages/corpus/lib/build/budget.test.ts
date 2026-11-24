// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { availableParallelism } from "@mailwoman/core/utils/system"
import { describe, expect, it } from "vitest"

import { defaultBuildJobs, HOST_RESERVE_BYTES, planWorkerBudget, workerReservationBytes } from "#build/budget"

describe("defaultBuildJobs", () => {
	const adapter = workerReservationBytes("adapter")
	const align = workerReservationBytes("align")

	it("builds serially when only one adapter worker fits", () => {
		expect(defaultBuildJobs({ hostMemoryBytes: HOST_RESERVE_BYTES + adapter })).toBe(1)
	})

	it("fills the memory beside one adapter worker with align workers, capped at the CPU count", () => {
		const jobs = defaultBuildJobs({ hostMemoryBytes: HOST_RESERVE_BYTES + adapter + 3 * align })

		expect(jobs).toBe(Math.min(availableParallelism(), 4))
	})
})

describe("planWorkerBudget", () => {
	it("refuses a host that holds no adapter worker", () => {
		expect(() =>
			planWorkerBudget({ jobs: 2, hostMemoryBytes: HOST_RESERVE_BYTES + workerReservationBytes("adapter") / 2 })
		).toThrow(/No parallel build fits this host/u)
	})
})
