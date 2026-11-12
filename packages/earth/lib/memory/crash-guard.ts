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
 *   Each one records the ID of the page load that wrote it and the time it was written.
 *
 *   A reload counts only a breadcrumb younger than {@linkcode CRASH_WINDOW_MS}.
 *   An older one is from a visit that ended some other way, and the reload removes it without counting it.
 *
 *   `localStorage` is shared by every tab of the site, so a fresh breadcrumb may
 *   belong to a tab that is still running its phase.
 *   Where the Web Locks API exists, the writer holds a lock whose name includes
 *   its page-load ID while the phase runs.
 *
 *   The browser releases a lock when its holder closes or crashes, so a breadcrumb
 *   whose owner still holds a lock belongs to a live tab and doesn't count.
 *
 *   A normal reload or navigation fires `pagehide`, which removes the page's own breadcrumbs,
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
 * The prefix of the Web Locks a page load holds while a phase runs, followed by its owner ID.
 */
export const LOCK_PREFIX = "mailwoman-crash-guard:"

/**
 * The age, in milliseconds, under which a breadcrumb counts as a crash on the next load.
 *
 * Safari reloads a killed tab within seconds.
 * Two minutes also covers a reader who reopens the page by hand after the crash page.
 */
export const CRASH_WINDOW_MS = 2 * 60 * 1000

/**
 * How long, in milliseconds, a load waits for the lock snapshot before it treats the locks as unknown.
 */
export const LOCK_QUERY_TIMEOUT_MS = 250

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
 * The part of the Web Locks `LockManager` the guard uses.
 */
export interface CrashGuardLocks {
	request(name: string, callback: () => Promise<void>): Promise<unknown>
	query(): Promise<{ held?: Array<{ name?: string }> }>
}

/**
 * What the guard found on this load.
 */
export interface CrashGuardReading {
	/**
	 * Whether a breadcrumb younger than {@linkcode CRASH_WINDOW_MS} had no live owner.
	 */
	tripped: boolean
	/**
	 * The phases the earlier load was in when it ended.
	 */
	phases: HeavyPhase[]
}

export interface CrashGuardOptions {
	now?: () => number
	/**
	 * This page load's ID.
	 * Each load picks a new one.
	 */
	ownerID?: string
	/**
	 * The Web Locks manager, or `null` where the browser has none.
	 */
	locks?: CrashGuardLocks | null
}

interface Breadcrumb {
	key: string
	phase: HeavyPhase
	ownerID: string | null
	writtenAt: number
}

/**
 * Reads a breadcrumb key, `<prefix><phase>:<ownerID>`, and its stored time.
 *
 * A key without an owner, from before breadcrumbs recorded one, reads with a null owner.
 */
function readBreadcrumb(key: string, value: string | null): Breadcrumb {
	const [phase = "", ownerID = null] = key.slice(KEY_PREFIX.length).split(":")

	return { key, phase: phase as HeavyPhase, ownerID, writtenAt: Number(value) }
}

/**
 * Writes and clears heavy-phase breadcrumbs in one storage.
 *
 * Every storage and lock call is wrapped, because Safari's private mode and blocked site data can throw.
 * A guard whose storage throws reads as clear on every load.
 */
export class CrashGuard {
	readonly ownerID: string
	#storage: BreadcrumbStorage | null
	#now: () => number
	#locks: CrashGuardLocks | null
	#releases = new Map<HeavyPhase, () => void>()

	constructor(storage: BreadcrumbStorage | null, options: CrashGuardOptions = {}) {
		this.#storage = storage
		this.#now = options.now ?? Date.now
		this.ownerID = options.ownerID ?? crypto.randomUUID()
		this.#locks = options.locks ?? null
	}

	/**
	 * Reads the breadcrumbs earlier loads left and removes the ones it accounts for.
	 *
	 * A breadcrumb older than {@linkcode CRASH_WINDOW_MS}, or one whose time can't
	 * be read, is removed without counting.
	 * A fresh one whose owner still holds a lock is a live tab's, so it stays and doesn't count.
	 */
	async takeEarlierReading(): Promise<CrashGuardReading> {
		const phases: HeavyPhase[] = []

		try {
			const storage = this.#storage

			if (!storage) return { tripped: false, phases }

			const breadcrumbs: Breadcrumb[] = []

			for (let index = 0; index < storage.length; index++) {
				const key = storage.key(index)

				if (key?.startsWith(KEY_PREFIX)) {
					breadcrumbs.push(readBreadcrumb(key, storage.getItem(key)))
				}
			}

			const now = this.#now()

			const fresh = breadcrumbs.filter(({ writtenAt, ownerID }) => {
				const age = now - writtenAt

				return Number.isFinite(writtenAt) && age >= 0 && age < CRASH_WINDOW_MS && ownerID !== this.ownerID
			})

			for (const breadcrumb of breadcrumbs.filter((candidate) => !fresh.includes(candidate))) {
				if (breadcrumb.ownerID !== this.ownerID) {
					storage.removeItem(breadcrumb.key)
				}
			}

			const liveOwners = fresh.length ? await this.#liveOwners() : new Set<string>()

			for (const breadcrumb of fresh) {
				if (breadcrumb.ownerID && liveOwners.has(breadcrumb.ownerID)) continue

				phases.push(breadcrumb.phase)
				storage.removeItem(breadcrumb.key)
			}
		} catch {
			return { tripped: false, phases: [] }
		}

		return { tripped: phases.length > 0, phases }
	}

	/**
	 * The owner IDs whose locks the browser reports held.
	 *
	 * Without the Web Locks API, or when the snapshot fails or takes longer than
	 * {@linkcode LOCK_QUERY_TIMEOUT_MS}, no owner reads as live.
	 */
	async #liveOwners(): Promise<Set<string>> {
		const owners = new Set<string>()

		if (!this.#locks) return owners

		try {
			const timeout = new Promise<null>((resolve) => {
				setTimeout(() => resolve(null), LOCK_QUERY_TIMEOUT_MS)
			})

			const snapshot = await Promise.race([this.#locks.query(), timeout])

			for (const { name } of snapshot?.held ?? []) {
				if (name?.startsWith(LOCK_PREFIX)) {
					owners.add(name.slice(LOCK_PREFIX.length).split(":")[0]!)
				}
			}
		} catch {
			owners.clear()
		}

		return owners
	}

	/**
	 * Marks `phase` as running, and holds this load's lock for it until {@linkcode CrashGuard.end}.
	 */
	begin(phase: HeavyPhase): void {
		try {
			this.#storage?.setItem(`${KEY_PREFIX}${phase}:${this.ownerID}`, String(this.#now()))
		} catch {
			// A full or blocked storage leaves the phase unmarked.
		}

		if (!this.#locks || this.#releases.has(phase)) return

		try {
			const held = new Promise<void>((resolve) => {
				this.#releases.set(phase, resolve)
			})

			void this.#locks.request(`${LOCK_PREFIX}${this.ownerID}:${phase}`, () => held).catch(() => {})
		} catch {
			this.#releases.delete(phase)
		}
	}

	/**
	 * Marks `phase` as finished, whether it succeeded or failed with an error the page caught.
	 */
	end(phase: HeavyPhase): void {
		try {
			this.#storage?.removeItem(`${KEY_PREFIX}${phase}:${this.ownerID}`)
		} catch {
			// A blocked storage held no breadcrumb to remove.
		}

		this.#releases.get(phase)?.()
		this.#releases.delete(phase)
	}

	/**
	 * Removes this load's breadcrumbs, as a normal unload does.
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

/**
 * The page's Web Locks manager, or `null` where the browser has none.
 */
export function pageLocks(): CrashGuardLocks | null {
	try {
		return (globalThis.navigator as (Navigator & { locks?: CrashGuardLocks }) | undefined)?.locks ?? null
	} catch {
		return null
	}
}
