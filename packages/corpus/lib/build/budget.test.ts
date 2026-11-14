// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { availableParallelism } from "@mailwoman/core/utils/system"
import { describe, expect, it } from "vitest"

import { defaultBuildJobs, HOST_RESERVE_BYTES, workerReservationBytes } from "#build/budget"

describe("defaultBuildJobs", () => {
	const standard = workerReservationBytes("standard")

	it("builds serially when fewer than two standard workers fit", () => {
		expect(defaultBuildJobs({ hostMemoryBytes: HOST_RESERVE_BYTES + standard })).toBe(1)
	})

	it("runs as many workers as memory holds, capped at the CPU count", () => {
		const jobs = defaultBuildJobs({ hostMemoryBytes: HOST_RESERVE_BYTES + 2 * standard })

		expect(jobs).toBe(availableParallelism() >= 2 ? 2 : 1)
	})
})
