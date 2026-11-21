// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The probe against a fixture server started as a child process: the listening wait,
 * a JSON projection, truncation, a 500 reported as a response, an early exit,
 * an expired startup wait under a fake clock, and a server that only SIGKILL stops.
 *
 * Each test confirms by process id that the server is gone after the probe returns.
 */

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { processExists } from "@mailwoman/core/fs/lock"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { ProbeExit, runProbe } from "#check-kit/probe/server"

const FIXTURE = repoRootPath("test", "fixtures", "check-kit", "probe-server.ts").toString()

async function probe(mode: string, options: Partial<Parameters<typeof runProbe>[0]> = {}) {
	await using scratch = await temporaryDirectory("probe-test-")

	const result = await runProbe({
		workspace: "fixture",
		command: {
			executable: process.execPath,
			args: [FIXTURE, mode, "--host", "127.0.0.1", "--port", "0"],
			cwd: repoRootPath().toString(),
		},
		gets: [],
		startupTimeoutMs: 30_000,
		logDirectory: scratch.path().toString(),
		...options,
	})

	expect(result.stop.pid).toEqual(expect.any(Number))
	expect(result.stop.remaining).toEqual([])
	expect(processExists(result.stop.pid!)).toBe(false)

	return result
}

describe("runProbe", () => {
	it("waits for the listening line, projects a JSON body, and reports a 500 as a response", async () => {
		const result = await probe("listen", { gets: ["/json", "/fail"], jsonPath: "meta.count" })

		expect(result).toMatchObject({ outcome: "listened", exitCode: ProbeExit.Passed })
		expect(result.listening?.line).toContain("listening on http://127.0.0.1:")

		const [json, failure] = result.requests

		expect(json).toMatchObject({ status: 200, body: null, json: { present: true, value: 2 } })
		expect(failure).toMatchObject({ status: 500, body: "internal error", json: { present: false } })
		expect(result.stop).toMatchObject({ signalSent: "SIGTERM", forced: false })
	})

	it("truncates a body at the cap and reports an absent JSON path as absent", async () => {
		const result = await probe("listen", { gets: ["/large", "/json"], maxBytes: 100, jsonPath: "meta.total" })
		const [large, json] = result.requests

		expect(large).toMatchObject({ truncated: true, bytesRead: 100 })
		expect(large?.body).toHaveLength(100)
		expect(json?.json).toEqual({ path: "meta.total", present: false, error: expect.stringContaining("absent") })
		expect(json?.body).toContain("conformsTo")
	})

	it("returns the exit status and the error of a server that exits before listening, and sends no request", async () => {
		const result = await probe("exit-early", { gets: ["/json"] })

		expect(result).toMatchObject({
			outcome: "exited-before-listening",
			exitCode: ProbeExit.ExitedBeforeListening,
			earlyExit: { exitCode: 3, signal: null },
			requests: [],
			listening: null,
		})

		expect(result.outputTail).toContain("Error: no such table: layer_manifest")
	})

	it("stops a server that never listens once the startup wait expires", async () => {
		const result = await probe("silent", { gets: ["/json"], clock: createFakeClock() })

		expect(result).toMatchObject({ outcome: "startup-expired", exitCode: ProbeExit.StartupExpired })
		expect(result.requests).toEqual([])
	})

	it("sends SIGKILL to a server that ignores SIGTERM past the grace period", async () => {
		const result = await probe("stubborn", { gets: ["/json"], stopGraceMs: 300 })

		expect(result.exitCode).toBe(ProbeExit.Passed)
		expect(result.stop).toMatchObject({ forced: true, signal: "SIGKILL" })
	})
})
