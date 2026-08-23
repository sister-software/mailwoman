// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { regionKeys } from "@mailwoman/resolver-wof-sqlite/region-keys"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { describe, expect, it } from "vitest"

describe("regionKeys", () => {
	it("adds county-prefix and province-suffix variants", () => {
		expect(regionKeys("Co. Westmeath")).toContain(normalizeLocalityForKey("Westmeath"))
		expect(regionKeys("County Durham")).toContain(normalizeLocalityForKey("Durham"))
		expect(regionKeys("San José Province")).toContain(normalizeLocalityForKey("San José"))
		expect(regionKeys("San José Prov.")).toContain(normalizeLocalityForKey("San José"))
	})

	it("does not strip embedded qualifier words", () => {
		const value = "Province Road"

		expect(regionKeys(value)).toEqual(new Set([normalizeLocalityForKey(value)]))
	})

	it("handles long non-matching input without regex backtracking", () => {
		const value = `North ${"x".repeat(100_000)}`

		expect(regionKeys(value)).toContain(normalizeLocalityForKey(value))
	})
})
