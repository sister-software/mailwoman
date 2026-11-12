// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import {
	type BreadcrumbStorage,
	CRASH_WINDOW_MS,
	CrashGuard,
	type CrashGuardLocks,
	HeavyPhase,
} from "#memory/crash-guard"
import { DeviceTier } from "#memory/device-tier"
import { buildMemoryProfile } from "#memory/profile"

class MemoryStorage implements BreadcrumbStorage {
	#items = new Map<string, string>()

	get length(): number {
		return this.#items.size
	}

	key(index: number): string | null {
		return [...this.#items.keys()][index] ?? null
	}

	getItem(key: string): string | null {
		return this.#items.get(key) ?? null
	}

	setItem(key: string, value: string): void {
		this.#items.set(key, value)
	}

	removeItem(key: string): void {
		this.#items.delete(key)
	}
}

/**
 * A lock manager shared by the guards of several simulated tabs.
 *
 * A tab's crash is simulated by `drop`, which releases its locks as the browser would.
 */
class FakeLocks implements CrashGuardLocks {
	held = new Set<string>()

	request(name: string, callback: () => Promise<void>): Promise<unknown> {
		this.held.add(name)

		return callback().finally(() => this.held.delete(name))
	}

	async query(): Promise<{ held: Array<{ name: string }> }> {
		return { held: [...this.held].map((name) => ({ name })) }
	}

	drop(ownerID: string): void {
		for (const name of this.held) {
			if (name.includes(ownerID)) {
				this.held.delete(name)
			}
		}
	}
}

const T0 = 1_000_000

describe("CrashGuard", () => {
	test("trips on the load after one that ended mid-phase, then clears", async () => {
		const storage = new MemoryStorage()

		new CrashGuard(storage, { now: () => T0, ownerID: "a" }).begin(HeavyPhase.Model)

		const reload = new CrashGuard(storage, { now: () => T0 + 5000, ownerID: "b" })

		expect(await reload.takeEarlierReading()).toEqual({ tripped: true, phases: [HeavyPhase.Model] })
		expect(await reload.takeEarlierReading()).toEqual({ tripped: false, phases: [] })
	})

	test("stays clear after a phase that ended", async () => {
		const storage = new MemoryStorage()
		const guard = new CrashGuard(storage, { ownerID: "a" })

		guard.begin(HeavyPhase.ThreeD)
		guard.end(HeavyPhase.ThreeD)

		expect((await new CrashGuard(storage, { ownerID: "b" }).takeEarlierReading()).tripped).toBe(false)
	})

	test("stays clear after a normal unload clears a running phase", async () => {
		const storage = new MemoryStorage()
		const guard = new CrashGuard(storage, { ownerID: "a" })

		guard.begin(HeavyPhase.Model)
		guard.clear()

		expect((await new CrashGuard(storage, { ownerID: "b" }).takeEarlierReading()).tripped).toBe(false)
	})

	test("counts a breadcrumb up to two minutes old", async () => {
		const storage = new MemoryStorage()

		new CrashGuard(storage, { now: () => T0, ownerID: "a" }).begin(HeavyPhase.Model)

		const reload = new CrashGuard(storage, { now: () => T0 + CRASH_WINDOW_MS - 1, ownerID: "b" })

		expect(await reload.takeEarlierReading()).toEqual({ tripped: true, phases: [HeavyPhase.Model] })
	})

	test("removes an older breadcrumb without counting it", async () => {
		const storage = new MemoryStorage()

		new CrashGuard(storage, { now: () => T0, ownerID: "a" }).begin(HeavyPhase.ThreeD)

		const later = new CrashGuard(storage, { now: () => T0 + CRASH_WINDOW_MS, ownerID: "b" })

		expect(await later.takeEarlierReading()).toEqual({ tripped: false, phases: [] })
		expect(storage).toHaveLength(0)
	})

	test("removes a breadcrumb whose time can't be read, or lies in the future, without counting it", async () => {
		const storage = new MemoryStorage()

		storage.setItem("mailwoman:heavy-phase:model:a", "not a time")
		storage.setItem("mailwoman:heavy-phase:3d:a", String(T0 * 2))

		expect((await new CrashGuard(storage, { now: () => T0, ownerID: "b" }).takeEarlierReading()).tripped).toBe(false)
		expect(storage).toHaveLength(0)
	})

	test("counts a breadcrumb written before breadcrumbs named their owner", async () => {
		const storage = new MemoryStorage()

		storage.setItem("mailwoman:heavy-phase:model", String(T0))

		const reading = await new CrashGuard(storage, { now: () => T0 + 1000, ownerID: "b" }).takeEarlierReading()

		expect(reading).toEqual({ tripped: true, phases: [HeavyPhase.Model] })
	})

	test("ignores keys that aren't breadcrumbs", async () => {
		const storage = new MemoryStorage()

		storage.setItem("unrelated", "1")

		expect((await new CrashGuard(storage, { ownerID: "b" }).takeEarlierReading()).tripped).toBe(false)
		expect(storage.getItem("unrelated")).toBe("1")
	})

	test("reports nothing when storage throws", async () => {
		const throwing: BreadcrumbStorage = {
			get length(): number {
				throw new Error("SecurityError")
			},
			key: () => null,
			getItem: () => null,
			setItem: () => {
				throw new Error("QuotaExceededError")
			},
			removeItem: () => {},
		}

		const guard = new CrashGuard(throwing, { ownerID: "a" })

		expect(() => guard.begin(HeavyPhase.Model)).not.toThrow()
		expect(await guard.takeEarlierReading()).toEqual({ tripped: false, phases: [] })
	})
})

describe("CrashGuard with Web Locks", () => {
	test("leaves a live tab's fresh breadcrumb and doesn't trip", async () => {
		const storage = new MemoryStorage()
		const locks = new FakeLocks()
		const otherTab = new CrashGuard(storage, { now: () => T0, ownerID: "tab-a", locks })

		otherTab.begin(HeavyPhase.Model)

		const reading = await new CrashGuard(storage, {
			now: () => T0 + 1000,
			ownerID: "tab-b",
			locks,
		}).takeEarlierReading()

		expect(reading).toEqual({ tripped: false, phases: [] })
		expect(storage).toHaveLength(1)
	})

	test("trips when the breadcrumb's owner no longer holds its lock", async () => {
		const storage = new MemoryStorage()
		const locks = new FakeLocks()

		new CrashGuard(storage, { now: () => T0, ownerID: "tab-a", locks }).begin(HeavyPhase.ThreeD)
		locks.drop("tab-a")

		const reading = await new CrashGuard(storage, {
			now: () => T0 + 1000,
			ownerID: "tab-b",
			locks,
		}).takeEarlierReading()

		expect(reading).toEqual({ tripped: true, phases: [HeavyPhase.ThreeD] })
		expect(storage).toHaveLength(0)
	})

	test("releases the lock when the phase ends", async () => {
		const storage = new MemoryStorage()
		const locks = new FakeLocks()
		const guard = new CrashGuard(storage, { ownerID: "tab-a", locks })

		guard.begin(HeavyPhase.Model)
		expect(locks.held).toEqual(new Set(["mailwoman-crash-guard:tab-a:model"]))

		guard.end(HeavyPhase.Model)
		await Promise.resolve()

		expect(locks.held.size).toBe(0)
	})

	test("trips as without locks when the lock snapshot fails", async () => {
		const storage = new MemoryStorage()

		const failing: CrashGuardLocks = {
			request: async () => {},
			query: () => Promise.reject(new Error("SecurityError")),
		}

		new CrashGuard(storage, { now: () => T0, ownerID: "tab-a" }).begin(HeavyPhase.Model)

		const reading = await new CrashGuard(storage, {
			now: () => T0 + 1000,
			ownerID: "tab-b",
			locks: failing,
		}).takeEarlierReading()

		expect(reading.tripped).toBe(true)
	})
})

describe("buildMemoryProfile", () => {
	const desktop = {
		coarsePointer: false,
		screenShortSide: 1080,
		maxTouchPoints: 0,
		userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
		deviceMemory: null,
	}

	test("keeps the detected tier and 3D on a clean load", () => {
		const profile = buildMemoryProfile(desktop, { tripped: false, phases: [] })

		expect(profile.tier).toBe(DeviceTier.Desktop)
		expect(profile.threeD).toBe(true)
	})

	test("steps down one tier and turns 3D off after a tripped guard", () => {
		const profile = buildMemoryProfile(desktop, { tripped: true, phases: [HeavyPhase.ThreeD] })

		expect(profile.detectedTier).toBe(DeviceTier.Desktop)
		expect(profile.tier).toBe(DeviceTier.Tablet)
		expect(profile.threeD).toBe(false)
	})
})
