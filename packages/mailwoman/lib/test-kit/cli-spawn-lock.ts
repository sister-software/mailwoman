/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Serializes CLI spawns across vitest workers with an async directory lock. The lock stores the holder's pid so a crashed worker's lock can be reclaimed. A `finally` block always releases the lock.
 */

import { tempRootPathBuilder } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectoryExclusive, removePathIfPresent, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sleep } from "@mailwoman/core/utils/sleep"

const LOCK_DIR = tempRootPathBuilder("mailwoman-cli-spawn.lock")
const PID_FILE = LOCK_DIR("pid")

/**
 * How long to wait for the lock before giving up and running anyway, deliberately not
 * infinite so a wedged lock degrades to contention rather than a hang.
 */
const ACQUIRE_TIMEOUT_MS = 120_000
const POLL_MS = 50

/**
 * Removes the lock directory while tolerating every failure.
 *
 * A failed removal lets the next acquirer reclaim the directory as stale.
 * A thrown lock error would turn contention into a test failure.
 */
async function releaseQuietly(): Promise<void> {
	try {
		await removePathIfPresent(LOCK_DIR)
	} catch {
		// Another worker may be removing or writing the lock.
		// Its stale check will reclaim it.
	}
}

async function staleHolder(): Promise<boolean> {
	try {
		const pid = Number.parseInt(await readLocalTextFile(PID_FILE), 10)

		if (!Number.isInteger(pid) || pid <= 0) return true
		// Signal 0 tests for existence without delivering anything.
		process.kill(pid, 0)

		return false
	} catch {
		// An unreadable pid file or a pid that no longer exists means the holder is gone.
		return true
	}
}

/**
 * Runs `fn` with the CLI-spawn lock held, always releasing even when `fn` throws.
 */
export async function withCLISpawnLockAsync<T>(fn: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
	let held = false

	// oxlint-disable-next-line eslint/no-unreachable-loop -- retryable catch falls through to the next timed attempt
	while (Date.now() < deadline) {
		try {
			await makeDirectoryExclusive(LOCK_DIR)
			await writeLocalTextFile(String(process.pid), PID_FILE)
			held = true

			break
		} catch {
			if (await staleHolder()) {
				await releaseQuietly()

				continue
			}

			await sleep(POLL_MS)
		}
	}

	try {
		return await fn()
	} finally {
		if (held) {
			await releaseQuietly()
		}
	}
}
