// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The recognizer the parse pipeline reads, `computeQueryShape`, runs on a Chromium page's main thread.
 *
 *   The first call instantiates the embedded engine synchronously, with no `init`.
 *
 *   Run with `yarn workspace @mailwoman/postcode test:browser`.
 */

import { expect, it } from "vitest"

import { computeQueryShape } from "#recognize/query-shape"

it("computes the structural fields and the known formats on the first call in Chromium", () => {
	const agent = (globalThis as { navigator?: { userAgent: string } }).navigator?.userAgent ?? ""

	expect(agent).toContain("Chrome")

	// No `await` precedes this call, so the compile and instantiate it makes are synchronous.
	const shape = computeQueryShape("350 5th Ave, New York, NY 10118")

	expect(shape.characterClass).toBe("alphanumeric")
	expect(shape.segments.map(({ body }) => body)).toEqual(["350 5th Ave", "New York", "NY 10118"])
	expect(shape.knownFormats.map(({ format }) => format)).toEqual(["us_zip", "fr_postcode", "de_postcode"])
})

it("reads a script other than Latin", () => {
	const shape = computeQueryShape("〒100-0001 東京都千代田区千代田1-1")

	expect(shape.scripts[0]?.script).toBe("Hani")
	expect(shape.knownFormats.map(({ format }) => format)).toEqual(["jp_postcode"])
})
