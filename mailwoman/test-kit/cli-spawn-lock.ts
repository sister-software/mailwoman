/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Serialize CLI spawns across vitest workers.
 *
 *   Vitest runs test FILES in parallel across forked workers, and several suites spawn the compiled CLI as a child
 *   process. Each spawn is expensive and heavy in a way that is easy to underestimate: measured 2026-08-03 on an idle
 *   16-core box, one `mailwoman geocode` costs 5.62 s wall, 541 MB RSS and 11 threads — 2.73 s of that is node boot
 *   plus the CLI's import graph, before any model loads. Eight concurrent spawns took 8.75 s, against a 10 s timeout.
 *
 *   Raising the timeout (which we also did) buys margin; it does not stop the stacking. This does. A lock is the right
 *   shape rather than a vitest concurrency setting because the constraint is not "this file is slow" but "these
 *   processes contend for the whole machine" — a property of the child, invisible to the runner.
 *
 *   The lock is a DIRECTORY, because `mkdir` is atomic on every platform we run on and needs no dependency. It carries
 *   the holder's pid so a crashed worker's lock can be reclaimed rather than wedging the suite, and it always releases
 *   in a `finally` — a leaked test lock turns one failure into a whole-suite timeout.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOCK_DIR = join(tmpdir(), "mailwoman-cli-spawn.lock")
const PID_FILE = join(LOCK_DIR, "pid")

/**
 * How long to wait for the lock before giving up and running anyway. Deliberately generous relative to a spawn (~6 s)
 * and deliberately NOT infinite: a wedged lock must degrade to the old contended behaviour, never to a hang that reads
 * as a mysterious suite timeout.
 */
const ACQUIRE_TIMEOUT_MS = 120_000
const POLL_MS = 50

/**
 * Block this thread for `ms`. Deliberately synchronous: every call site wraps `execFileSync`, which blocks the thread
 * anyway, so an async lock would force those suites to be restructured for no behavioural gain. `Atomics.wait` on a
 * throwaway buffer is the supported way to sleep without spinning a core.
 */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function staleHolder(): boolean {
	try {
		const pid = Number.parseInt(readFileSync(PID_FILE, "utf8"), 10)

		if (!Number.isInteger(pid) || pid <= 0) return true
		// Signal 0 tests for existence without delivering anything.
		process.kill(pid, 0)

		return false
	} catch {
		// Unreadable pid file, or a pid that no longer exists — either way the holder is gone.
		return true
	}
}

/**
 * Run `fn` with the CLI-spawn lock held. Always releases, including when `fn` throws.
 */
export function withCLISpawnLock<T>(fn: () => T): T {
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
	let held = false

	// The catch path sleeps and retries; only a successful mkdir breaks out. oxlint reads the try/break as
	// the loop's sole exit and misses the fallthrough, the same false positive scripts/bless-package.ts
	// suppressed for its OTP retry. The directive must sit immediately above the loop — on a multi-line
	// note it lands on the next COMMENT line and silently does nothing.
	// oxlint-disable-next-line eslint/no-unreachable-loop
	while (Date.now() < deadline) {
		try {
			mkdirSync(LOCK_DIR)
			writeFileSync(PID_FILE, String(process.pid))
			held = true

			break
		} catch {
			if (staleHolder()) {
				rmSync(LOCK_DIR, { recursive: true, force: true })

				continue
			}

			sleepSync(POLL_MS)
		}
	}

	try {
		return fn()
	} finally {
		if (held) {
			rmSync(LOCK_DIR, { recursive: true, force: true })
		}
	}
}

/**
 * Async sibling of {@link withCLISpawnLock}, for call sites that `await` a spawn rather than blocking on it. Same lock,
 * so the two forms serialize against each other — a suite using `exec` and one using `execFileSync` still queue behind
 * one another, which is the point.
 */
export async function withCLISpawnLockAsync<T>(fn: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
	let held = false

	// The catch path sleeps and retries; only a successful mkdir breaks out. oxlint reads the try/break as
	// the loop's sole exit and misses the fallthrough, the same false positive scripts/bless-package.ts
	// suppressed for its OTP retry. The directive must sit immediately above the loop — on a multi-line
	// note it lands on the next COMMENT line and silently does nothing.
	// oxlint-disable-next-line eslint/no-unreachable-loop
	while (Date.now() < deadline) {
		try {
			mkdirSync(LOCK_DIR)
			writeFileSync(PID_FILE, String(process.pid))
			held = true

			break
		} catch {
			if (staleHolder()) {
				rmSync(LOCK_DIR, { recursive: true, force: true })

				continue
			}

			await new Promise((resolve) => {
				setTimeout(resolve, POLL_MS)
			})
		}
	}

	try {
		return await fn()
	} finally {
		if (held) {
			rmSync(LOCK_DIR, { recursive: true, force: true })
		}
	}
}
