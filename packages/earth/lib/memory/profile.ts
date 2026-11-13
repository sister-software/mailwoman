// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The page's memory profile: its device tier, the crash guard's reading,
 *   and the 3D budget that follows from both.
 *
 *   The page reads the profile once per load.
 *   The reading asks the browser which locks are held, so it settles after the first render.
 *
 *   Until then the profile is `null`.
 *   The 3D layers mount only after it settles, and the memory readout prints "checking…" in its place.
 *
 *   A tripped crash guard steps the tier down one class and turns 3D off for the rest of the load.
 *   Heavy-phase breadcrumbs don't depend on the profile, so the model's breadcrumb is written
 *   before its fetch whether or not the reading has settled.
 */

import { useSyncExternalStore } from "react"

import { CrashGuard, type CrashGuardReading, HeavyPhase, pageLocalStorage, pageLocks } from "#memory/crash-guard"
import {
	type DeviceSignals,
	type DeviceTier,
	detectDeviceTier,
	readDeviceSignals,
	stepDownTier,
	THREE_D_BUDGETS,
	type ThreeDBudget,
} from "#memory/device-tier"

/**
 * What one load decided about memory.
 */
export interface MemoryProfile {
	/**
	 * The tier the device's readings give.
	 */
	detectedTier: DeviceTier
	/**
	 * The tier in force, one class below `detectedTier` when the crash guard tripped.
	 */
	tier: DeviceTier
	crashGuard: CrashGuardReading
	/**
	 * Whether the 3D layers may mount on this load.
	 */
	threeD: boolean
	budget: ThreeDBudget
}

/**
 * Derives a profile from the device's readings and the crash guard's reading.
 */
export function buildMemoryProfile(signals: DeviceSignals, crashGuard: CrashGuardReading): MemoryProfile {
	const detectedTier = detectDeviceTier(signals)
	const tier = crashGuard.tripped ? stepDownTier(detectedTier) : detectedTier

	return {
		detectedTier,
		tier,
		crashGuard,
		threeD: !crashGuard.tripped,
		budget: THREE_D_BUDGETS[tier],
	}
}

/**
 * One load's profile, `null` until the crash guard's reading settles.
 */
export class MemoryProfileStore {
	#guard: CrashGuard
	#signals: () => DeviceSignals
	#profile: MemoryProfile | null = null
	#loading: Promise<MemoryProfile> | null = null
	#listeners = new Set<() => void>()

	constructor(guard: CrashGuard, signals: () => DeviceSignals) {
		this.#guard = guard
		this.#signals = signals
	}

	/**
	 * Starts the reading once and returns its result.
	 */
	load(): Promise<MemoryProfile> {
		this.#loading ??= this.#guard.takeEarlierReading().then((reading) => {
			this.#profile = buildMemoryProfile(this.#signals(), reading)

			for (const listener of this.#listeners) {
				listener()
			}

			return this.#profile
		})

		return this.#loading
	}

	/**
	 * The settled profile, or `null` while the reading runs.
	 */
	current = (): MemoryProfile | null => this.#profile

	/**
	 * Calls `listener` when the profile settles, in the shape `useSyncExternalStore` takes.
	 */
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)

		return () => this.#listeners.delete(listener)
	}
}

const guard = new CrashGuard(pageLocalStorage(), { locks: pageLocks() })
const store = new MemoryProfileStore(guard, readDeviceSignals)

/**
 * Starts this load's crash-guard reading, and removes this load's breadcrumbs on a normal unload.
 *
 * The page calls it before its first render and doesn't wait for it.
 */
export function loadMemoryProfile(): Promise<MemoryProfile> {
	globalThis.addEventListener?.("pagehide", () => guard.clear())

	return store.load()
}

/**
 * This load's profile in a component, or `null` until {@linkcode loadMemoryProfile} settles.
 * The component renders again when it settles.
 */
export function useMemoryProfile(): MemoryProfile | null {
	return useSyncExternalStore(store.subscribe, store.current, store.current)
}

/**
 * Marks `phase` as running until `work` settles.
 */
export async function guardHeavyPhase<T>(phase: HeavyPhase, work: () => Promise<T>): Promise<T> {
	guard.begin(phase)

	try {
		return await work()
	} finally {
		guard.end(phase)
	}
}

/**
 * Marks the 3D phase as running until the returned function is called.
 */
export function beginThreeDPhase(): () => void {
	guard.begin(HeavyPhase.ThreeD)

	return () => guard.end(HeavyPhase.ThreeD)
}
