// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { primaryActionAfterWorkerExit, WORKER_RESPAWN_LIMIT } from "#cli/kit/cluster/exit"

/**
 * A worker that had been serving exits, in a cluster that listened, with zero replacements so far.
 */
const SERVING_WORKER_EXITED: Parameters<typeof primaryActionAfterWorkerExit>[0] = {
	liveWorkers: 0,
	anyListened: true,
	shuttingDown: false,
	workerListened: true,
	recentRespawns: 0,
}

describe("the serve primary's action after a worker exits", () => {
	it("replaces a worker that had been serving, whether or not others are alive", () => {
		expect(primaryActionAfterWorkerExit(SERVING_WORKER_EXITED)).toEqual({ respawn: true })
		expect(primaryActionAfterWorkerExit({ ...SERVING_WORKER_EXITED, liveWorkers: 3 })).toEqual({ respawn: true })
	})

	it("replaces up to the limit inside the window, and stops at the next exit", () => {
		expect(
			primaryActionAfterWorkerExit({ ...SERVING_WORKER_EXITED, recentRespawns: WORKER_RESPAWN_LIMIT - 1 })
		).toEqual({ respawn: true })

		expect(
			primaryActionAfterWorkerExit({ ...SERVING_WORKER_EXITED, recentRespawns: WORKER_RESPAWN_LIMIT })
		).toMatchObject({ respawn: false, code: 1, reason: expect.stringContaining("after the cluster listened") })
	})

	it("past the limit, keeps running while another worker is alive", () => {
		expect(
			primaryActionAfterWorkerExit({
				...SERVING_WORKER_EXITED,
				liveWorkers: 1,
				recentRespawns: WORKER_RESPAWN_LIMIT,
			})
		).toBeNull()
	})

	it("forks no replacement for a worker that exited before it listened", () => {
		const bootFailure = { ...SERVING_WORKER_EXITED, workerListened: false }

		expect(primaryActionAfterWorkerExit({ ...bootFailure, liveWorkers: 2 })).toBeNull()

		expect(primaryActionAfterWorkerExit({ ...bootFailure, anyListened: false })).toMatchObject({
			respawn: false,
			code: 1,
			reason: expect.stringContaining("before any listened"),
		})
	})

	it("leaves a forwarded shutdown to its own exit", () => {
		expect(primaryActionAfterWorkerExit({ ...SERVING_WORKER_EXITED, shuttingDown: true })).toBeNull()
	})
})
