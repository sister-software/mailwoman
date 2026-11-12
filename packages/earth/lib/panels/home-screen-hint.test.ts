// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { wantsHomeScreenHint } from "#panels/home-screen-hint"

const IPHONE_SAFARI =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

const IPHONE_CHROME =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1"

const MAC_SAFARI =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

describe("wantsHomeScreenHint", () => {
	test("shows for Safari on an iPhone outside the Home Screen", () => {
		expect(wantsHomeScreenHint({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5, standalone: false })).toBe(true)
	})

	test("shows for Safari on an iPad that sends a Mac user agent", () => {
		expect(wantsHomeScreenHint({ userAgent: MAC_SAFARI, maxTouchPoints: 5, standalone: false })).toBe(true)
	})

	test("hides once the page runs from the Home Screen", () => {
		expect(wantsHomeScreenHint({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5, standalone: true })).toBe(false)
	})

	test("hides for Chrome on iOS and for Safari on a Mac", () => {
		expect(wantsHomeScreenHint({ userAgent: IPHONE_CHROME, maxTouchPoints: 5, standalone: false })).toBe(false)
		expect(wantsHomeScreenHint({ userAgent: MAC_SAFARI, maxTouchPoints: 0, standalone: false })).toBe(false)
	})
})
