import { availableParallelism } from "@mailwoman/core/utils/system"
import { describe, expect, it } from "vitest"

import { defaultBuildJobs, HOST_RESERVE_BYTES, workerReservationBytes } from "#build/budget"

describe("defaultBuildJobs", () => {
	const standard = workerReservationBytes("standard")
	const resident = workerReservationBytes("resident")

	it("builds serially when fewer than two standard workers fit", () => {
		expect(defaultBuildJobs({ adapterIDs: ["usgov-nppes"], hostMemoryBytes: HOST_RESERVE_BYTES + standard })).toBe(1)
	})

	it("runs as many workers as memory holds, capped at the CPU count", () => {
		const hostMemoryBytes = HOST_RESERVE_BYTES + 2 * standard
		const jobs = defaultBuildJobs({ adapterIDs: ["usgov-nppes"], hostMemoryBytes })

		expect(jobs).toBe(availableParallelism() >= 2 ? 2 : 1)
	})

	it("builds serially when a resident adapter would not fit in a worker", () => {
		// Two standard workers fit and a resident one does not.
		const hostMemoryBytes = HOST_RESERVE_BYTES + Math.min(2 * standard, resident - 1)

		expect(resident).toBeGreaterThan(2 * standard)

		expect(defaultBuildJobs({ adapterIDs: ["usgov-nppes"], hostMemoryBytes })).toBe(availableParallelism() >= 2 ? 2 : 1)

		expect(defaultBuildJobs({ adapterIDs: ["wof-admin"], hostMemoryBytes })).toBe(1)
	})
})
