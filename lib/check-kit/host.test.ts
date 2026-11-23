// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The host wait over a scratch lock directory, a fake clock and a stubbed CI reader.
 */

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { acquireDirectoryLock } from "@mailwoman/core/fs/lock"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { hostName } from "@mailwoman/core/utils/system"
import { describe, expect, it } from "vitest"

import type { CIRunsReading } from "#check-kit/ci-runs"
import { acquireHost, readHostStatus, waitForIdleHost } from "#check-kit/host"

const IDLE: CIRunsReading = { read: true, runs: [], excluded: [] }

const BUSY: CIRunsReading = {
	read: true,
	runs: [
		{
			id: 1,
			workflow: "Test",
			branch: "main",
			status: "in_progress",
			event: "push",
			createdAt: "2026-11-20T17:00:00Z",
			url: "https://example.invalid/1",
		},
	],
	excluded: [],
}

/**
 * Hold the lock as the parent process.
 * That process is alive and isn't this one.
 */
async function holdAsParent(lockDir: string): Promise<void> {
	await makeDirectories(lockDir)

	await writeLocalJSONFile(
		{
			pid: process.ppid,
			host: hostName(),
			started_at: "2026-11-20T00:00:00.000Z",
			detail: { check: "lint", checkout: "/elsewhere" },
		},
		`${lockDir}/owner.json`
	)
}

describe("acquireHost", () => {
	it("returns no lock and names the holder when the wait bound expires", async () => {
		await using scratch = await temporaryDirectory("host-test-")
		const lockDir = scratch.path("host.lock").toString()
		const clock = createFakeClock()

		await holdAsParent(lockDir)

		const acquired = await acquireHost({ check: "compile" }, 10 * 60_000, false, {
			lockDir,
			clock,
			readCI: async () => IDLE,
		})

		expect(acquired.lock).toBeNull()
		expect(acquired.lockWait).toMatchObject({ expired: true, waitedMs: 10 * 60_000 })
		expect(acquired.lockWait.holder?.detail).toEqual({ check: "lint", checkout: "/elsewhere" })
	})

	it("starts after the CI bound expires and records the runs still active", async () => {
		await using scratch = await temporaryDirectory("host-test-")
		const clock = createFakeClock()

		const acquired = await acquireHost({ check: "compile" }, 60_000, false, {
			lockDir: scratch.path("host.lock").toString(),
			clock,
			readCI: async () => BUSY,
		})

		await using _lock = acquired.lock

		expect(acquired.lock).not.toBeNull()
		expect(acquired.ciWait.expired).toBe(true)
		expect(acquired.ciWait.waitedMs).toBe(60_000)
	})

	it("holds no lock while it waits for CI, and takes it once CI is idle", async () => {
		await using scratch = await temporaryDirectory("host-test-")
		const lockDir = scratch.path("host.lock").toString()
		const clock = createFakeClock()
		const readings = [BUSY, BUSY, IDLE]
		const lockHeldAtRead: boolean[] = []

		const acquired = await acquireHost({ check: "compile" }, 60 * 60_000, false, {
			lockDir,
			clock,
			readCI: async () => {
				lockHeldAtRead.push(await pathExists(lockDir))

				return readings.shift()!
			},
		})

		await using _lock = acquired.lock

		expect(lockHeldAtRead).toEqual([false, false, false])
		expect(acquired.lock).not.toBeNull()
		expect(acquired.ciWait.expired).toBe(false)
		expect(await pathExists(lockDir)).toBe(true)
	})

	it("refuses at once under --no-wait while another process holds the lock", async () => {
		await using scratch = await temporaryDirectory("host-test-")
		const lockDir = scratch.path("host.lock").toString()
		const clock = createFakeClock()

		await holdAsParent(lockDir)

		const acquired = await acquireHost({ check: "compile" }, 60_000, true, { lockDir, clock, readCI: async () => IDLE })

		expect(acquired.lock).toBeNull()
		expect(clock.sleepCalls).toEqual([])
	})
})

describe("readHostStatus", () => {
	it("reads a free lock with unread CI as unknown, not idle", async () => {
		const status = await readHostStatus({
			lockDir: "/nonexistent/mwops-host-status-test.lock",
			readCI: async () => ({ read: false, error: "gh: authentication required" }),
		})

		expect(status.lock).toEqual({ state: "free" })
		expect(status.idle).toBeNull()
	})

	it("reads a lock held by this process as busy", async () => {
		await using scratch = await temporaryDirectory("host-test-")
		const lockDir = scratch.path("host.lock").toString()

		await using _lock = await acquireDirectoryLock(lockDir, () => "held")

		const status = await readHostStatus({ lockDir, readCI: async () => IDLE })

		expect(status.lock.state).toBe("held")
		expect(status.idle).toBe(false)
	})
})

describe("waitForIdleHost", () => {
	it("ends as unread when CI stayed unreadable through the bound", async () => {
		const clock = createFakeClock()

		const wait = await waitForIdleHost(90_000, {
			lockDir: "/nonexistent/mwops-host-wait-test.lock",
			clock,
			readCI: async () => ({ read: false, error: "timeout" }),
		})

		expect(wait.outcome).toBe("unread")
		expect(wait.waitedMs).toBe(90_000)
	})
})
