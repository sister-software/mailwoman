// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { primaryExitAfterWorkerExit } from "#cli/kit/cluster/exit"

describe("the serve primary's exit after a worker exits", () => {
	it("keeps running while any worker is alive", () => {
		expect(primaryExitAfterWorkerExit({ liveWorkers: 1, anyListened: true, shuttingDown: false })).toBeNull()
		expect(primaryExitAfterWorkerExit({ liveWorkers: 2, anyListened: false, shuttingDown: false })).toBeNull()
	})

	it("exits 1 when every worker died before one listened", () => {
		expect(primaryExitAfterWorkerExit({ liveWorkers: 0, anyListened: false, shuttingDown: false })).toMatchObject({
			code: 1,
			reason: expect.stringContaining("before any listened"),
		})
	})

	it("exits 1 when every worker died after the cluster listened, so a supervisor restarts it", () => {
		expect(primaryExitAfterWorkerExit({ liveWorkers: 0, anyListened: true, shuttingDown: false })).toMatchObject({
			code: 1,
			reason: expect.stringContaining("after the cluster listened"),
		})
	})

	it("leaves a forwarded shutdown to its own exit", () => {
		expect(primaryExitAfterWorkerExit({ liveWorkers: 0, anyListened: true, shuttingDown: true })).toBeNull()
	})
})
