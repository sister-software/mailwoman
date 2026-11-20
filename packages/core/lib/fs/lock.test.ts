// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The directory lock's acquire, release, stale-owner and bounded-wait behavior, over a scratch directory
 *   and a fake clock.
 */

import { describe, expect, it } from "vitest"

import { createFakeClock } from "#api/test/clocks"
import { acquireDirectoryLock, type DirectoryLockOwner, waitForDirectoryLock } from "#fs/lock"
import { tryReadLocalJSONFile } from "#fs/readers"
import { pathExists } from "#fs/readers/stat"
import { temporaryDirectory } from "#fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "#fs/writers"
import { spawnProcessSync } from "#process"
import { hostName } from "#utils/system"

/**
 * Write an owner record as another process would have.
 */
async function seedOwner(lockDir: string, owner: Partial<DirectoryLockOwner>): Promise<void> {
	await makeDirectories(lockDir)

	await writeLocalJSONFile(
		{ host: hostName(), started_at: "2026-11-20T00:00:00.000Z", pid: 0, ...owner },
		`${lockDir}/owner.json`
	)
}

/**
 * The pid of a process that exited before this returns.
 */
function exitedPid(): number {
	const child = spawnProcessSync(process.execPath, ["-e", ""])

	return child.pid
}

describe("directory lock", () => {
	it("records the holder and releases on disposal", async () => {
		await using scratch = await temporaryDirectory("lock-test-")
		const lockDir = scratch.path("held.lock").toString()

		{
			await using lock = await acquireDirectoryLock(lockDir, () => "held", { detail: { check: "compile" } })
			const recorded = await tryReadLocalJSONFile<DirectoryLockOwner>(`${lockDir}/owner.json`)

			expect(recorded?.pid).toBe(process.pid)
			expect(recorded?.detail).toEqual({ check: "compile" })
			// Linux exposes the start time in `/proc`, so the record stores it.
			expect(typeof recorded?.process_started).toBe("string")
			expect(lock.path).toBe(lockDir)
		}

		expect(await pathExists(lockDir)).toBe(false)
	})

	it("refuses while a live process on this host holds the lock", async () => {
		await using scratch = await temporaryDirectory("lock-test-")
		const lockDir = scratch.path("held.lock").toString()

		// The lock judges a record without a start time by whether its pid exists.
		await seedOwner(lockDir, { pid: process.ppid })

		await expect(acquireDirectoryLock(lockDir, (held) => `held by ${held?.pid}`)).rejects.toThrow(
			`held by ${process.ppid}`
		)
	})

	it("releases a lock whose owner process no longer exists", async () => {
		await using scratch = await temporaryDirectory("lock-test-")
		const lockDir = scratch.path("held.lock").toString()
		const dead = exitedPid()
		const released: string[] = []

		await seedOwner(lockDir, { pid: dead })

		await using lock = await acquireDirectoryLock(lockDir, () => "held", {
			onStaleRelease: (held, reason) => released.push(`${held.pid}: ${reason}`),
		})

		expect(lock.owner.pid).toBe(process.pid)
		expect(released).toEqual([`${dead}: process ${dead} no longer exists`])
	})

	it("releases a lock whose pid now belongs to a process with another start time", async () => {
		await using scratch = await temporaryDirectory("lock-test-")
		const lockDir = scratch.path("held.lock").toString()
		const released: string[] = []

		// The parent process exists, but not with this start time, so the record describes an earlier process.
		await seedOwner(lockDir, { pid: process.ppid, process_started: "1" })

		await using lock = await acquireDirectoryLock(lockDir, () => "held", {
			onStaleRelease: (_held, reason) => released.push(reason),
		})

		expect(lock.owner.pid).toBe(process.pid)
		expect(released[0]).toContain("the pid was reused")
	})

	it("stops waiting at the bound and reports the holder", async () => {
		await using scratch = await temporaryDirectory("lock-test-")
		const lockDir = scratch.path("held.lock").toString()
		const clock = createFakeClock()

		await seedOwner(lockDir, { pid: process.ppid, detail: { check: "lint" } })

		const waited = await waitForDirectoryLock(lockDir, { maxWaitMs: 60_000, pollMs: 5000, clock })

		expect(waited.lock).toBeUndefined()
		expect(waited.held?.detail).toEqual({ check: "lint" })
		expect(waited.waitedMs).toBe(60_000)
		expect(clock.sleepCalls.every((ms) => ms <= 5000)).toBe(true)
	})

	it("takes the lock once the holder releases it during the wait", async () => {
		await using scratch = await temporaryDirectory("lock-test-")
		const lockDir = scratch.path("held.lock").toString()
		const clock = createFakeClock()
		const first = await acquireDirectoryLock(lockDir, () => "held")
		// The record holds this process's pid.
		// A waiter in the same process never judges its own record stale.
		let polls = 0

		const waited = await waitForDirectoryLock(lockDir, {
			maxWaitMs: 60_000,
			pollMs: 5000,
			clock,
			onWait: () => {
				polls++

				if (polls === 2) {
					void first[Symbol.asyncDispose]()
				}
			},
		})

		await using _lock = waited.lock

		expect(waited.lock).toBeDefined()
		expect(waited.waitedMs).toBeLessThan(60_000)
	})
})
