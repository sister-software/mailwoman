// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { type JobEvent, jobMachine, JobRegistry, type JobState } from "#dev-mcp/jobs"

describe("the job lifecycle", () => {
	it.each([
		// state, event, expected
		["running", { kind: "close", code: 0, signal: null }, "succeeded"],
		["running", { kind: "close", code: 1, signal: null }, "failed"],
		["running", { kind: "close", code: null, signal: "SIGTERM" }, "cancelled"],
		["running", { kind: "error" }, "failed"],
		["running", { kind: "cancel" }, "cancelled"],
		["cancelled", { kind: "close", code: 1, signal: null }, "cancelled"],
		["cancelled", { kind: "error" }, "cancelled"],
		["cancelled", { kind: "cancel" }, "cancelled"],
		["succeeded", { kind: "error" }, "succeeded"],
		["succeeded", { kind: "cancel" }, "succeeded"],
		["failed", { kind: "close", code: 0, signal: null }, "failed"],
		["failed", { kind: "cancel" }, "failed"],
	] as Array<[JobState, JobEvent, JobState]>)("%s on %o reads %s", (state, event, expected) => {
		expect(jobMachine.transition(state, event).next).toBe(expected)
	})

	it("a cancelled job whose kill fails stays cancelled and keeps its child for a later kill", () => {
		const registry = new JobRegistry()
		const job = registry.start("sleeper", process.execPath, ["-e", "setTimeout(() => {}, 30000)"], process.cwd())
		const child = job.child

		try {
			expect(registry.cancel(job.jobID)).toBe(true)

			child?.emit("error", new Error("kill EPERM"))

			expect(job.state).toBe("cancelled")
			expect(job.child).toBe(child)
			expect(job.stderr).toContain("kill EPERM")
		} finally {
			child?.kill("SIGKILL")
		}
	})
})
