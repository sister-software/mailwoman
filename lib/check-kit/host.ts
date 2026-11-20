// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The host's heavy-job state: the host lock a heavy `mwops check` holds,
 * and the CI runs the host's runners execute.
 *
 * The lock lives under the Mailwoman cache root rather than in a checkout,
 * so every checkout and worktree on the host takes the same one.
 * It is `@mailwoman/core/fs/lock`'s directory lock.
 *
 * That lock releases a holder whose process is gone or whose pid now belongs
 * to a process with another start time.
 */

import { type ClockLike, systemClock } from "@mailwoman/core/api/clock"
import { cacheRootPath } from "@mailwoman/core/data-root"
import {
	type DirectoryLock,
	type DirectoryLockOwner,
	staleOwnerReason,
	waitForDirectoryLock,
} from "@mailwoman/core/fs/lock"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { dirname } from "path-ts"

import { type CIRunsReading, readActiveCIRuns } from "#check-kit/ci-runs"

/**
 * How long a heavy check waits for the host lock and for CI before the bound expires: 20 minutes.
 *
 * The longest wait a check meets is a CI test job on this host's runners.
 * The slow suite's Vitest run took 842.77 s in the failed CI log of 2026-11-20 for #3142, and the
 * root fast suite took 409.70 s locally, so 20 minutes covers one full slow-suite job with margin.
 *
 * It is also the bound the repository instructions set for a hand-written CI wait.
 */
export const DEFAULT_MAX_WAIT_MINUTES = 20

/**
 * The interval between a waiter's attempts at the lock.
 */
const LOCK_POLL_MS = 5000

/**
 * The interval between a waiter's CI reads.
 *
 * Each read is two `gh` calls, so the interval is six times the lock's.
 */
const CI_POLL_MS = 30_000

/**
 * The host lock directory, shared by every checkout that resolves the same cache root.
 */
function hostLockPath(): string {
	return cacheRootPath("host", "heavy-check.lock")
}

/**
 * The services the host functions read through, injected by a test.
 */
export interface HostServices {
	lockDir?: string
	clock?: ClockLike
	readCI?: () => Promise<CIRunsReading>
	log?: (line: string) => void
}

/**
 * What the host lock directory holds.
 */
type HostLockReading =
	| { state: "free" }
	| { state: "held"; holder: DirectoryLockOwner; stale: string | null }
	| { state: "unreadable"; path: string }

/**
 * Read the host lock without changing it.
 *
 * A lock directory without a readable owner record reads as `unreadable`, never as free.
 */
async function readHostLock(lockDir: string = hostLockPath()): Promise<HostLockReading> {
	if (!(await pathExists(lockDir))) return { state: "free" }

	const holder = await tryReadLocalJSONFile<DirectoryLockOwner>(`${lockDir}/owner.json`).catch(() => null)

	if (!holder) return { state: "unreadable", path: lockDir }

	return { state: "held", holder, stale: await staleOwnerReason(holder) }
}

/**
 * The host's state: the lock, the CI runs, and whether both are idle.
 *
 * `idle` is `null` when the lock is free and CI couldn't be read, because the state is then unknown.
 */
export interface HostStatus {
	lock: HostLockReading
	ci: CIRunsReading
	idle: boolean | null
}

function lockIsFree(lock: HostLockReading): boolean {
	return lock.state === "free" || (lock.state === "held" && lock.stale != null)
}

/**
 * Read the host lock and the CI runs.
 */
export async function readHostStatus(services: HostServices = {}): Promise<HostStatus> {
	const [lock, ci] = await Promise.all([readHostLock(services.lockDir), (services.readCI ?? readActiveCIRuns)()])

	const idle = !lockIsFree(lock) ? false : ci.read ? !ci.runs.length : null

	return { lock, ci, idle }
}

/**
 * How a bounded wait for an idle host ended.
 *
 * `unread` means the bound expired while CI couldn't be read, so idleness was never established.
 */
export interface HostWait {
	outcome: "idle" | "expired" | "unread"
	waitedMs: number
	maxWaitMs: number
	status: HostStatus
}

/**
 * Poll the host until both the lock and CI are idle, or `maxWaitMs` passes.
 */
export async function waitForIdleHost(maxWaitMs: number, services: HostServices = {}): Promise<HostWait> {
	const clock = services.clock ?? systemClock
	const startedAt = clock.now()

	for (;;) {
		const status = await readHostStatus(services)
		const waitedMs = clock.now() - startedAt

		if (status.idle === true) return { outcome: "idle", waitedMs, maxWaitMs, status }

		if (waitedMs >= maxWaitMs) {
			return { outcome: status.idle === null ? "unread" : "expired", waitedMs, maxWaitMs, status }
		}

		await clock.sleep(Math.min(CI_POLL_MS, maxWaitMs - waitedMs))
	}
}

/**
 * What a heavy check recorded while it waited for the host.
 */
export interface HostAcquisition {
	/**
	 * The held lock, or `null` when the wait for it expired.
	 */
	lock: DirectoryLock | null
	lockWait: {
		waitedMs: number
		expired: boolean
		/**
		 * The owner that still held the lock when the wait expired.
		 */
		holder: DirectoryLockOwner | null
		/**
		 * One message per stale holder released before the lock was taken.
		 */
		staleReleased: string[]
	}
	ciWait: {
		waitedMs: number
		/**
		 * Whether the bound expired with CI still busy, so the check started beside a CI job.
		 */
		expired: boolean
		/**
		 * The last CI reading before the check started.
		 */
		reading: CIRunsReading | null
	}
}

/**
 * Take the host lock and wait for CI to finish, within one shared bound.
 *
 * The lock is taken first and held through the CI wait, so a second checkout's
 * heavy check can't start between the two.
 * When the CI wait expires the check still runs, and the acquisition records that.
 *
 * When CI can't be read the wait stops, because further reads are likely to fail
 * the same way, and the reading records the error.
 *
 * @param noWait Try the lock once and read CI once, without waiting on either.
 */
export async function acquireHost(
	detail: Record<string, unknown>,
	maxWaitMs: number,
	noWait: boolean,
	services: HostServices = {}
): Promise<HostAcquisition> {
	const clock = services.clock ?? systemClock
	const readCI = services.readCI ?? readActiveCIRuns
	const log = services.log ?? (() => {})
	const staleReleased: string[] = []
	const startedAt = clock.now()
	let lastHolder: string | null = null
	const lockDir = services.lockDir ?? hostLockPath()

	// The lock is a non-recursive `mkdir`, so its parent must exist first.
	await makeDirectories(dirname(lockDir))

	const waited = await waitForDirectoryLock(lockDir, {
		maxWaitMs: noWait ? 0 : maxWaitMs,
		pollMs: LOCK_POLL_MS,
		clock,
		detail,
		onStaleRelease: (held, reason) => {
			const message = `released the host lock left by pid ${held.pid} (${String(held.detail?.["check"] ?? "unknown check")}): ${reason}`

			staleReleased.push(message)
			log(message)
		},
		onWait: (held) => {
			const holder = held ? describeHolder(held) : "an owner whose record is unreadable"

			if (holder !== lastHolder) {
				log(`waiting for the host lock, held by ${holder}`)
				lastHolder = holder
			}
		},
	})

	const lockWait = {
		waitedMs: waited.waitedMs,
		expired: !waited.lock,
		holder: waited.held ?? null,
		staleReleased,
	}

	if (!waited.lock) return { lock: null, lockWait, ciWait: { waitedMs: 0, expired: false, reading: null } }

	const ciStartedAt = clock.now()
	let reading = await readCI()

	// Under --no-wait the bound is zero, so the first reading is the one recorded.
	const ciBoundMs = noWait ? 0 : maxWaitMs

	while (reading.read && reading.runs.length) {
		const remaining = ciBoundMs - (clock.now() - startedAt)

		if (remaining <= 0) break

		log(`waiting for ${reading.runs.length} CI run(s): ${reading.runs.map((run) => run.workflow).join(", ")}`)
		await clock.sleep(Math.min(CI_POLL_MS, remaining))
		reading = await readCI()
	}

	return {
		lock: waited.lock,
		lockWait,
		ciWait: {
			waitedMs: clock.now() - ciStartedAt,
			expired: reading.read && reading.runs.length > 0,
			reading,
		},
	}
}

/**
 * One phrase naming a lock holder, for a log line.
 */
export function describeHolder(holder: DirectoryLockOwner): string {
	const check = holder.detail?.["check"]
	const checkout = holder.detail?.["checkout"]

	return (
		`pid ${holder.pid}` +
		(typeof check === "string" ? ` running ${check}` : "") +
		(typeof checkout === "string" ? ` in ${checkout}` : "") +
		` since ${holder.started_at}`
	)
}
