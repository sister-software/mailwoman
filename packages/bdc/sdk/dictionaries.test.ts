// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { isBroadbandServicableLocationID } from "#sdk/location"

test("isBroadbandServicableLocationID: accepts a 10-digit string, preserving a leading zero", () => {
	expect(isBroadbandServicableLocationID("0012345678")).toBe(true)
})

test("isBroadbandServicableLocationID: rejects a number, even with matching digits", () => {
	expect(isBroadbandServicableLocationID(12_345_678)).toBe(false)
	expect(isBroadbandServicableLocationID(12_345_678 as unknown)).toBe(false)
})

test("isBroadbandServicableLocationID: rejects strings that aren't exactly 10 digits", () => {
	expect(isBroadbandServicableLocationID("123456789")).toBe(false)
	expect(isBroadbandServicableLocationID("12345678901")).toBe(false)
	expect(isBroadbandServicableLocationID("abcdefghij")).toBe(false)
})
