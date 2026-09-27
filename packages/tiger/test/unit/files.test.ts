// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { parseTIGERRelease } from "@mailwoman/tiger"
import { describe, expect, it } from "vitest"

describe("parseTIGERRelease", () => {
	it("reads the vintage year from a release tag", () => {
		expect(parseTIGERRelease("TIGER2023")).toBe(2023)
		expect(parseTIGERRelease("TIGER2024")).toBe(2024)
	})

	it("rejects a tag that is not TIGER followed by a four-digit year", () => {
		expect(() => parseTIGERRelease("2023")).toThrow(/TIGER2023/)
		expect(() => parseTIGERRelease("TIGER23")).toThrow(/TIGER23/)
	})
})
