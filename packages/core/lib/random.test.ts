// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { makeLcg, mulberry32, SeededRandom } from "#random"

describe("mulberry32", () => {
	it("is a deterministic stream from one seed", () => {
		const a = mulberry32(42)
		const b = mulberry32(42)
		expect(a()).toBe(b())
		expect(a()).toBe(b())
	})

	it("differs across seeds", () => {
		expect(mulberry32(1)()).not.toBe(mulberry32(2)())
	})
})

describe("makeLcg", () => {
	it("is deterministic", () => {
		expect(makeLcg(7)()).toBe(makeLcg(7)())
	})
})

describe("SeededRandom", () => {
	it("wraps a seeded stream", () => {
		const r = new SeededRandom(99)
		const v = r.random()
		expect(v).toBeGreaterThanOrEqual(0)
		expect(v).toBeLessThan(1)
	})
})
