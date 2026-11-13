// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import {
	bytesPerTileset,
	type DeviceSignals,
	DeviceTier,
	detectDeviceTier,
	stepDownTier,
	THREE_D_BUDGETS,
} from "#memory/device-tier"

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"

function signals(overrides: Partial<DeviceSignals>): DeviceSignals {
	return {
		coarsePointer: false,
		screenShortSide: 900,
		maxTouchPoints: 0,
		userAgent: MAC_UA,
		deviceMemory: null,
		...overrides,
	}
}

describe("detectDeviceTier", () => {
	test("reads a coarse pointer on a 393-pixel screen as a phone", () => {
		expect(
			detectDeviceTier(signals({ coarsePointer: true, screenShortSide: 393, maxTouchPoints: 5, userAgent: IPHONE_UA }))
		).toBe(DeviceTier.Phone)
	})

	test("reads an iPad that sends a Mac user agent as a tablet", () => {
		expect(detectDeviceTier(signals({ coarsePointer: true, screenShortSide: 820, maxTouchPoints: 5 }))).toBe(
			DeviceTier.Tablet
		)
	})

	test("reads a Mac user agent with a fine pointer and no touch as a desktop", () => {
		expect(detectDeviceTier(signals({}))).toBe(DeviceTier.Desktop)
	})

	test("reads a large coarse-pointer screen as a tablet", () => {
		expect(detectDeviceTier(signals({ coarsePointer: true, screenShortSide: 800, userAgent: "Android" }))).toBe(
			DeviceTier.Tablet
		)
	})

	test("steps down one class when deviceMemory reports under 4 GiB", () => {
		expect(detectDeviceTier(signals({ deviceMemory: 2 }))).toBe(DeviceTier.Tablet)
		expect(detectDeviceTier(signals({ deviceMemory: 8 }))).toBe(DeviceTier.Desktop)
	})
})

describe("stepDownTier", () => {
	test("stops at the phone tier", () => {
		expect(stepDownTier(DeviceTier.Desktop)).toBe(DeviceTier.Tablet)
		expect(stepDownTier(DeviceTier.Tablet)).toBe(DeviceTier.Phone)
		expect(stepDownTier(DeviceTier.Phone)).toBe(DeviceTier.Phone)
	})
})

describe("bytesPerTileset", () => {
	const MIB = 1024 * 1024

	test("splits a phone's total among the tilesets drawing", () => {
		expect(bytesPerTileset(THREE_D_BUDGETS.phone, 1)).toBe(256 * MIB)
		expect(bytesPerTileset(THREE_D_BUDGETS.phone, 2)).toBe(128 * MIB)
	})

	test("keeps the desktop's 512 MiB for each tileset", () => {
		expect(bytesPerTileset(THREE_D_BUDGETS.desktop, 3)).toBe(512 * MIB)
	})
})
