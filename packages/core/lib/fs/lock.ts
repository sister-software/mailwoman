// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file An exclusive lock held as a directory for as long as its owner runs.
 *
 *   The lock is a directory created with a non-recursive `mkdir`, an atomic test-and-set, holding the owner's
 *   pid, host, start time and the kernel's start time for that pid. A second process refuses while the owner
 *   lives. A lock whose owner was a process on this host that no longer exists was left by a killed process, and
 *   the next caller takes it over. So is a lock whose pid now belongs to a process that started at another time,
 *   because the kernel reused the pid. A lock held from another host is never taken over, because its owner's
 *   liveness cannot be read from here.
 */

import type { PathBuilderLike } from "path-ts"

import { type ClockLike, systemClock } from "#api/clock"
import { readLocalTextFile, tryReadLocalJSONFile } from "#fs/readers"
import { makeDirectoryExclusive, removePathIfPresent, writeLocalJSONFile } from "#fs/writers"
import { stringifyJSON } from "#json"
import { hostName } from "#utils/system"

/**
 * What a lock directory records about the process holding it.
 */
export interface DirectoryLockOwner {
	pid: number
	host: string
	started_at: string
	/**
	 * The kernel's start time for `pid`, from {@link processStartTime}, so a reused pid reads as stale.
	 *
	 * `null` on a platform without `/proc`, and absent in a record written before the field existed.
	 * Either way only the pid's existence is checked.
	 */
	process_started?: string | null
	/**
	 * What the holder states about its work, such as the command it runs, for a waiter to report.
	 */
	detail?: Record<string, unknown>
}

/**
 * Options for {@link acquireDirectoryLock} and {@link waitForDirectoryLock}.
 */
export interface DirectoryLockOptions {
	/**
	 * Recorded in the owner file as {@link DirectoryLockOwner.detail}.
	 */
	detail?: Record<string, unknown>
	/**
	 * Called when a stale owner's lock is removed, with the reason it was judged stale.
	 */
	onStaleRelease?: (held: DirectoryLockOwner, reason: string) => void
}

/**
 * A held lock.
 *
 * Its disposal releases the lock when this process still owns it.
 */
export interface DirectoryLock extends AsyncDisposable {
	owner: DirectoryLockOwner
	path: string
}

/**
 * Whether a process with this pid exists on this host.
 *
 * Signal 0 is an existence check: the kernel reports whether the pid can be signaled and delivers no signal.
 * `EPERM` means the process exists under another user.
 */
export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)

		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * The kernel's start time for a process, in clock ticks since boot, read from `/proc/<pid>/stat`.
 *
 * Two processes that held one pid at different times have different start times.
 *
 * @returns `null` when the process doesn't exist or the platform has no `/proc`.
 */
async function processStartTime(pid: number): Promise<string | null> {
	let stat: string

	try {
		stat = await readLocalTextFile(`/proc/${pid}/stat`)
	} catch {
		return null
	}

	// The second field is the command name in parentheses and may itself hold spaces
	// or parentheses, so the fields are counted from the last closing parenthesis.
	// The start time is field 22, the 20th after it.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")

	return fields[19] ?? null
}

/**
 * Why a lock's owner no longer holds it, or `null` when the owner may still be running.
 *
 * Only an owner on this host can be judged.
 * The calling process never judges its own record stale.
 */
export async function staleOwnerReason(held: DirectoryLockOwner): Promise<string | null> {
	if (held.host !== hostName() || held.pid === process.pid) return null

	if (!processExists(held.pid)) return `process ${held.pid} no longer exists`

	if (typeof held.process_started === "string") {
		const current = await processStartTime(held.pid)

		if (typeof current === "string" && current !== held.process_started) {
			return `process ${held.pid} started at tick ${current}, not at the recorded tick ${held.process_started}, so the pid was reused`
		}
	}

	return null
}

/**
 * One attempt at the lock: the held lock, or the record of the owner that refused it.
 *
 * `held` is `null` when the owner record is absent or unreadable.
 */
type DirectoryLockAttempt = { lock: DirectoryLock; held?: never } | { lock?: never; held: DirectoryLockOwner | null }

/**
 * Try the lock at `lockDir` once, removing a stale owner's lock first.
 */
async function tryAcquireDirectoryLock(
	lockDir: PathBuilderLike,
	options: DirectoryLockOptions = {}
): Promise<DirectoryLockAttempt> {
	const path = lockDir.toString()
	const ownerPath = `${path}/owner.json`

	const owner: DirectoryLockOwner = {
		pid: process.pid,
		host: hostName(),
		started_at: new Date().toISOString(),
		process_started: await processStartTime(process.pid),
		...(options.detail ? { detail: options.detail } : {}),
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await makeDirectoryExclusive(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error

			// A half-written owner file reads as unreadable rather than throwing, and is refused below.
			const held = await tryReadLocalJSONFile<DirectoryLockOwner>(ownerPath).catch(() => null)

			// An owner file that's absent or unreadable belongs to a process between its `mkdir`
			// and its write, or to one killed in that window.
			// Neither can be told apart from here, so the caller refuses.
			const reason = held ? await staleOwnerReason(held) : null

			if (held && reason) {
				await removePathIfPresent(path)
				options.onStaleRelease?.(held, reason)

				continue
			}

			return { held }
		}

		await writeLocalJSONFile(owner, ownerPath)

		return {
			lock: {
				owner,
				path,
				[Symbol.asyncDispose]: async () => {
					const current = await tryReadLocalJSONFile<DirectoryLockOwner>(ownerPath)

					// Released only by its owner, so a process whose lock was removed by hand never deletes a successor's.
					if (current && stringifyJSON(current) === stringifyJSON(owner)) {
						await removePathIfPresent(path)
					}
				},
			},
		}
	}

	throw new Error(`the lock ${path} reappeared while a stale one was removed`)
}

/**
 * Take the lock at `lockDir`.
 *
 * @param refusal The message thrown when another live process holds the lock.
 * `held` is the owner record, or `null` when it is absent or unreadable.
 * @throws The `refusal` message when a live process, a process on another host,
 * or an owner whose record cannot be read holds the lock.
 */
export async function acquireDirectoryLock(
	lockDir: PathBuilderLike,
	refusal: (held: DirectoryLockOwner | null) => string,
	options: DirectoryLockOptions = {}
): Promise<DirectoryLock> {
	const attempt = await tryAcquireDirectoryLock(lockDir, options)

	if (attempt.lock) return attempt.lock

	throw new Error(refusal(attempt.held))
}

/**
 * Options for {@link waitForDirectoryLock}.
 */
export interface WaitForDirectoryLockOptions extends DirectoryLockOptions {
	/**
	 * How long to wait for a live owner to release the lock.
	 * Zero tries once.
	 */
	maxWaitMs: number
	/**
	 * The interval between attempts.
	 */
	pollMs: number
	clock?: ClockLike
	/**
	 * Called after each refused attempt, with the owner that refused it.
	 */
	onWait?: (held: DirectoryLockOwner | null, waitedMs: number) => void
}

/**
 * How a bounded wait for a lock ended: the held lock, or the owner still holding it when the bound expired.
 */
export type DirectoryLockWait =
	| { lock: DirectoryLock; waitedMs: number; held?: never }
	| { lock?: never; waitedMs: number; held: DirectoryLockOwner | null }

/**
 * Take the lock at `lockDir`, polling while a live owner holds it, for at most `maxWaitMs`.
 */
export async function waitForDirectoryLock(
	lockDir: PathBuilderLike,
	options: WaitForDirectoryLockOptions
): Promise<DirectoryLockWait> {
	const clock = options.clock ?? systemClock
	const startedAt = clock.now()

	for (;;) {
		const attempt = await tryAcquireDirectoryLock(lockDir, options)
		const waitedMs = clock.now() - startedAt

		if (attempt.lock) return { lock: attempt.lock, waitedMs }

		if (waitedMs >= options.maxWaitMs) return { held: attempt.held, waitedMs }

		options.onWait?.(attempt.held, waitedMs)
		await clock.sleep(Math.min(options.pollMs, options.maxWaitMs - waitedMs))
	}
}
