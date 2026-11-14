// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Clock-to-string helpers shared by the artifact builders.
 */

/**
 * The UTC calendar date as `yyyy-MM-DD`.
 */
export function isoDate(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10)
}

/**
 * The UTC instant at second precision with an explicit `+00:00` offset.
 *
 * The shape Python's `datetime.isoformat(timespec="seconds")` writes, so a manifest
 * built here and one built by the training code compare equal.
 */
export function isoSecondsUTC(now: Date = new Date()): string {
	return now.toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

/**
 * The UTC instant at second precision with the `Z` suffix.
 *
 * The RFC 3339 shape the artifact manifests and eval reports stamp.
 */
export function isoSeconds(now: Date = new Date()): string {
	return now.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * The wall-clock seconds one phase of a build took, under the phase's progress label.
 */
export interface PhaseTiming {
	phase: string
	seconds: number
}

/**
 * A clock that times the phases of a build from the phase names it reports.
 */
export interface PhaseClock {
	/**
	 * Starts `phase` and ends the phase that was running.
	 *
	 * A call naming the running phase leaves its start in place, so a phase that
	 * reports several progress lines is timed once.
	 * A phase that runs again later adds to its earlier time.
	 */
	mark(phase: string): void
	/**
	 * Ends the running phase and returns each phase's seconds, in the order the phases first ran.
	 */
	finish(): PhaseTiming[]
}

/**
 * The timings as one line, `ingest-wof 1234.5s, fold-overture 61s`, in the order given.
 */
export function formatPhaseTimings(timings: readonly PhaseTiming[]): string {
	return timings.map(({ phase, seconds }) => `${phase} ${seconds}s`).join(", ")
}

/**
 * Creates a {@linkcode PhaseClock} reading `now` in milliseconds.
 */
export function createPhaseClock(now: () => number = () => performance.now()): PhaseClock {
	const elapsed = new Map<string, number>()
	let running: { phase: string; start: number } | null = null

	const stop = () => {
		if (!running) return
		elapsed.set(running.phase, (elapsed.get(running.phase) ?? 0) + now() - running.start)
		running = null
	}

	return {
		mark(phase) {
			if (running?.phase === phase) return
			stop()
			running = { phase, start: now() }
		},
		finish() {
			stop()

			return [...elapsed].map(([phase, ms]) => ({ phase, seconds: Math.round(ms / 100) / 10 }))
		},
	}
}
