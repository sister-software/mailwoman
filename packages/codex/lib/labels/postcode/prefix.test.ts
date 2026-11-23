// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { postcodePrefixAt, postcodePrefixLevel } from "#labels/postcode/prefix"

describe("postcodePrefixLevel", () => {
	it("reads a country in either case and returns null for a country without a rule", () => {
		expect(postcodePrefixLevel("gb")).toBe("outward")
		expect(postcodePrefixLevel("US")).toBe("3")
		expect(postcodePrefixLevel("FR")).toBeNull()
		expect(postcodePrefixLevel("constructor")).toBeNull()
	})
})

describe("postcodePrefixAt", () => {
	it("drops the inward code whatever the outward code's length", () => {
		expect(postcodePrefixAt("EC1A1BB", "outward")).toBe("EC1A")
		expect(postcodePrefixAt("M11AE", "outward")).toBe("M1")
		expect(postcodePrefixAt("B33", "outward")).toBeNull()
	})

	it("keeps the leading digits of a fixed-width level", () => {
		expect(postcodePrefixAt("94043", "3")).toBe("940")
		expect(postcodePrefixAt("12", "3")).toBeNull()
	})
})
