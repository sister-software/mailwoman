// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The device class Earth sizes its 3D memory budgets by.
 *
 *   Safari exposes no memory reading, so the class comes from the pointer, the screen and the touch points.
 *   Chromium's `navigator.deviceMemory` refines the class where it exists.
 */

/**
 * The device classes, from the smallest memory budget to the largest.
 */
export const DeviceTier = {
	Phone: "phone",
	Tablet: "tablet",
	Desktop: "desktop",
} as const

export type DeviceTier = (typeof DeviceTier)[keyof typeof DeviceTier]

const TIER_ORDER: readonly DeviceTier[] = [DeviceTier.Phone, DeviceTier.Tablet, DeviceTier.Desktop]

/**
 * The browser readings the tier is chosen from.
 */
export interface DeviceSignals {
	/**
	 * Whether the primary pointer is coarse, as `(pointer: coarse)` reports for a touch screen.
	 */
	coarsePointer: boolean
	/**
	 * The screen's shorter side in CSS pixels.
	 */
	screenShortSide: number
	maxTouchPoints: number
	userAgent: string
	/**
	 * Chromium's approximate device memory in GiB, absent in Safari and Firefox.
	 */
	deviceMemory: number | null
}

/**
 * The shortest screen side, in CSS pixels, a coarse-pointer device needs to count as a tablet.
 *
 * Current phones in portrait are at most 440 CSS pixels wide, and the smallest iPad is 744.
 */
export const TABLET_MIN_SHORT_SIDE = 600

/**
 * The `navigator.deviceMemory` reading, in GiB, below which the tier steps down one class.
 */
export const LOW_DEVICE_MEMORY_GIB = 4

/**
 * The tier one class below `tier`, or `tier` itself at the bottom.
 */
export function stepDownTier(tier: DeviceTier): DeviceTier {
	return TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(tier) - 1)]!
}

/**
 * Chooses a tier from the device's pointer, screen and touch points, then steps it down once
 * when `deviceMemory` reports less than {@linkcode LOW_DEVICE_MEMORY_GIB}.
 *
 * iPadOS sends a Mac user agent, so a Mac user agent with more than one touch point is a tablet.
 */
export function detectDeviceTier(signals: DeviceSignals): DeviceTier {
	const iPadAsMac = /Macintosh/.test(signals.userAgent) && signals.maxTouchPoints > 1

	let tier: DeviceTier

	if (iPadAsMac) {
		tier = DeviceTier.Tablet
	} else if (signals.coarsePointer) {
		tier = signals.screenShortSide >= TABLET_MIN_SHORT_SIDE ? DeviceTier.Tablet : DeviceTier.Phone
	} else {
		tier = DeviceTier.Desktop
	}

	if (typeof signals.deviceMemory === "number" && signals.deviceMemory < LOW_DEVICE_MEMORY_GIB) {
		tier = stepDownTier(tier)
	}

	return tier
}

/**
 * Reads {@link DeviceSignals} from the page's globals.
 */
export function readDeviceSignals(): DeviceSignals {
	const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined
	const screen = globalThis.screen as Screen | undefined

	return {
		coarsePointer: globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
		screenShortSide: screen ? Math.min(screen.width, screen.height) : 0,
		maxTouchPoints: nav?.maxTouchPoints ?? 0,
		userAgent: nav?.userAgent ?? "",
		deviceMemory: typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null,
	}
}

/**
 * The memory the 3D city models may take on one tier.
 *
 * The GPU city-model layer and the PLATEAU tilesets never draw at once,
 * so whichever path draws takes the whole budget.
 * A path that draws several tilesets splits `totalBytes` among them,
 * and no tileset gets more than `perTilesetBytes`.
 */
export interface ThreeDBudget {
	totalBytes: number
	perTilesetBytes: number
}

const MIB = 1024 * 1024

/**
 * The 3D budgets by tier.
 *
 * These values are starting points for device measurement.
 * No device has measured them yet.
 * Reports put the iOS WebContent kill threshold near 2 GiB on recent iPhones.
 *
 * That figure is unconfirmed by Apple and covers the whole page, including the model,
 * the sqlite-wasm workers and MapLibre's tiles.
 * Desktop keeps its earlier 512 MiB for each tileset with no total.
 */
export const THREE_D_BUDGETS: Readonly<Record<DeviceTier, ThreeDBudget>> = {
	[DeviceTier.Phone]: { totalBytes: 256 * MIB, perTilesetBytes: 256 * MIB },
	[DeviceTier.Tablet]: { totalBytes: 512 * MIB, perTilesetBytes: 512 * MIB },
	[DeviceTier.Desktop]: { totalBytes: Number.POSITIVE_INFINITY, perTilesetBytes: 512 * MIB },
}

/**
 * The bytes one of `tilesets` drawing tilesets may hold under `budget`.
 */
export function bytesPerTileset(budget: ThreeDBudget, tilesets: number): number {
	return Math.min(budget.perTilesetBytes, budget.totalBytes / Math.max(1, tilesets))
}
