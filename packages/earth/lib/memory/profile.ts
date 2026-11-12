// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The page's memory profile: its device tier, the crash guard's reading,
 *   and the 3D budget that follows from both.
 *
 *   The page reads the profile once per load, before its first render.
 *   A tripped crash guard steps the tier down one class and turns 3D off for the rest of the load.
 */

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

const guard = new CrashGuard(pageLocalStorage(), { locks: pageLocks() })
let profile: MemoryProfile | null = null
let loading: Promise<MemoryProfile> | null = null

/**
 * Takes the crash guard's earlier reading and fixes this load's profile.
 *
 * The page awaits it before its first render, because the reading asks the browser which locks are held.
 */
export function loadMemoryProfile(): Promise<MemoryProfile> {
	loading ??= guard.takeEarlierReading().then((reading) => {
		profile = buildMemoryProfile(readDeviceSignals(), reading)
		globalThis.addEventListener?.("pagehide", () => guard.clear())

		return profile
	})

	return loading
}

/**
 * This load's profile.
 *
 * Until {@linkcode loadMemoryProfile} resolves, it returns the device tier
 * and a clear guard, without caching that answer.
 */
export function memoryProfile(): MemoryProfile {
	return profile ?? buildMemoryProfile(readDeviceSignals(), { tripped: false, phases: [] })
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
