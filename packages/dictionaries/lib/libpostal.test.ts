// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { readLibPostalSingleWordStopwords } from "#libpostal"

describe("readLibPostalSingleWordStopwords", () => {
	it("reads each language's articles from its own file", async () => {
		const english = await readLibPostalSingleWordStopwords("en")
		const french = await readLibPostalSingleWordStopwords("fr")

		expect(english.has("the")).toBe(true)
		expect(french.has("la")).toBe(true)
		expect(french.has("the")).toBe(false)
	})

	it("leaves out multi-word stopword phrases", async () => {
		const french = await readLibPostalSingleWordStopwords("fr")

		expect([...french].some((word) => /\s/u.test(word))).toBe(false)
	})

	it("returns an empty set for a language libpostal has no file for", async () => {
		expect((await readLibPostalSingleWordStopwords("zz")).size).toBe(0)
	})
})
