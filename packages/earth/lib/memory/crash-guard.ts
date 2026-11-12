// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Breadcrumbs that let a reload tell whether the previous load died during a heavy phase.
 *
 *   iOS ends a tab's WebContent process when it passes its memory limit, and Safari then reloads the page.
 *   The page gets no event when that happens.
 *
 *   A breadcrumb written before a heavy phase and removed after it is still
 *   there on the reload that follows a kill.
 *
 *   The breadcrumbs live in `localStorage`, which outlives a killed process.
 *   Each one holds the time it was written, and a reload counts only a breadcrumb
 *   younger than {@linkcode CRASH_WINDOW_MS}.
 *
 *   An older one is from a visit that ended some other way, and the reload removes it without counting it.
 *
 *   A normal reload or navigation fires `pagehide`, which removes them,
 *   so only a load that ended without `pagehide` leaves one behind.
 */

/**
 * The phases a crash breadcrumb marks.
 */
export const HeavyPhase = {
	/**
	 * Downloading the model and creating its ONNX Runtime session.
	 */
	Model: "model",
	/**
	 * Mounting a 3D building or city-model layer, until the map next goes idle.
	 */
	ThreeD: "3d",
} as const

export type HeavyPhase = (typeof HeavyPhase)[keyof typeof HeavyPhase]

const KEY_PREFIX = "mailwoman:heavy-phase:"

/**
 * The age, in milliseconds, under which a breadcrumb counts as a crash on the next load.
 *
 * Safari reloads a killed tab within seconds.
 * Two minutes also covers a reader who reopens the page by hand after the crash page.
 */
export const CRASH_WINDOW_MS = 2 * 60 * 1000

/**
 * The storage the guard writes, matching the part of `Storage` it uses.
 */
export interface BreadcrumbStorage {
	readonly length: number
	key(index: number): string | null
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

/**
 * What the guard found on this load.
 */
export interface CrashGuardReading {
	/**
	 * Whether a breadcrumb younger than {@linkcode CRASH_WINDOW_MS} was still present.
	 */
	tripped: boolean
	/**
	 * The phases the earlier load was in when it ended.
	 */
	phases: HeavyPhase[]
}

/**
 * Writes and clears heavy-phase breadcrumbs in one storage.
 *
 * Every storage call is wrapped, because Safari's private mode and blocked site data can throw.
 * A guard whose storage throws reads as clear on every load.
 */
export class CrashGuard {
	#storage: BreadcrumbStorage | null
	#now: () => number

	constructor(storage: BreadcrumbStorage | null, now: () => number = Date.now) {
		this.#storage = storage
		this.#now = now
	}

	/**
	 * Reads the breadcrumbs an earlier load left and removes them, so the next load starts clean.
	 *
	 * A breadcrumb older than {@linkcode CRASH_WINDOW_MS}, or one whose time can't
	 * be read, is removed without counting.
	 */
	takeEarlierReading(): CrashGuardReading {
		const phases: HeavyPhase[] = []

		try {
			const storage = this.#storage

			if (!storage) return { tripped: false, phases }

			const keys: string[] = []

			for (let index = 0; index < storage.length; index++) {
				const key = storage.key(index)

				if (key?.startsWith(KEY_PREFIX)) {
					keys.push(key)
				}
			}

			const now = this.#now()

			for (const key of keys) {
				const written = Number(storage.getItem(key))

				if (Number.isFinite(written) && now - written >= 0 && now - written < CRASH_WINDOW_MS) {
					phases.push(key.slice(KEY_PREFIX.length) as HeavyPhase)
				}

				storage.removeItem(key)
			}
		} catch {
			return { tripped: false, phases: [] }
		}

		return { tripped: phases.length > 0, phases }
	}

	/**
	 * Marks `phase` as running.
	 */
	begin(phase: HeavyPhase): void {
		try {
			this.#storage?.setItem(KEY_PREFIX + phase, String(this.#now()))
		} catch {
			// A full or blocked storage leaves the phase unmarked.
		}
	}

	/**
	 * Marks `phase` as finished, whether it succeeded or failed with an error the page caught.
	 */
	end(phase: HeavyPhase): void {
		try {
			this.#storage?.removeItem(KEY_PREFIX + phase)
		} catch {
			// A blocked storage held no breadcrumb to remove.
		}
	}

	/**
	 * Removes every breadcrumb, as a normal unload does.
	 */
	clear(): void {
		for (const phase of Object.values(HeavyPhase)) {
			this.end(phase)
		}
	}
}

/**
 * The page's `localStorage`, or `null` where reading it throws.
 */
export function pageLocalStorage(): BreadcrumbStorage | null {
	try {
		return globalThis.localStorage ?? null
	} catch {
		return null
	}
}
