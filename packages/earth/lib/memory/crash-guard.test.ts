// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { type BreadcrumbStorage, CRASH_WINDOW_MS, CrashGuard, HeavyPhase } from "#memory/crash-guard"
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

describe("CrashGuard", () => {
	test("trips on the load after one that ended mid-phase, then clears", () => {
		const storage = new MemoryStorage()

		new CrashGuard(storage).begin(HeavyPhase.Model)

		const reload = new CrashGuard(storage)

		expect(reload.takeEarlierReading()).toEqual({ tripped: true, phases: [HeavyPhase.Model] })
		expect(reload.takeEarlierReading()).toEqual({ tripped: false, phases: [] })
	})

	test("stays clear after a phase that ended", () => {
		const storage = new MemoryStorage()
		const guard = new CrashGuard(storage)

		guard.begin(HeavyPhase.ThreeD)
		guard.end(HeavyPhase.ThreeD)

		expect(new CrashGuard(storage).takeEarlierReading().tripped).toBe(false)
	})

	test("stays clear after a normal unload clears a running phase", () => {
		const storage = new MemoryStorage()
		const guard = new CrashGuard(storage)

		guard.begin(HeavyPhase.Model)
		guard.clear()

		expect(new CrashGuard(storage).takeEarlierReading().tripped).toBe(false)
	})

	test("counts a breadcrumb up to two minutes old", () => {
		const storage = new MemoryStorage()

		new CrashGuard(storage, () => 1_000_000).begin(HeavyPhase.Model)

		const reload = new CrashGuard(storage, () => 1_000_000 + CRASH_WINDOW_MS - 1)

		expect(reload.takeEarlierReading()).toEqual({ tripped: true, phases: [HeavyPhase.Model] })
	})

	test("removes an older breadcrumb without counting it", () => {
		const storage = new MemoryStorage()

		new CrashGuard(storage, () => 1_000_000).begin(HeavyPhase.ThreeD)

		const later = new CrashGuard(storage, () => 1_000_000 + CRASH_WINDOW_MS)

		expect(later.takeEarlierReading()).toEqual({ tripped: false, phases: [] })
		expect(storage).toHaveLength(0)
	})

	test("removes a breadcrumb whose time can't be read, or lies in the future, without counting it", () => {
		const storage = new MemoryStorage()

		storage.setItem("mailwoman:heavy-phase:model", "not a time")
		storage.setItem("mailwoman:heavy-phase:3d", String(2_000_000))

		expect(new CrashGuard(storage, () => 1_000_000).takeEarlierReading().tripped).toBe(false)
		expect(storage).toHaveLength(0)
	})

	test("ignores keys that aren't breadcrumbs", () => {
		const storage = new MemoryStorage()

		storage.setItem("unrelated", "1")

		expect(new CrashGuard(storage).takeEarlierReading().tripped).toBe(false)
		expect(storage.getItem("unrelated")).toBe("1")
	})

	test("reports nothing when storage throws", () => {
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

		const guard = new CrashGuard(throwing)

		expect(() => guard.begin(HeavyPhase.Model)).not.toThrow()
		expect(guard.takeEarlierReading()).toEqual({ tripped: false, phases: [] })
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
