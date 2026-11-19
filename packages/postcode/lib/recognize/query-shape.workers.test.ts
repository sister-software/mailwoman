// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The recognizer the parse pipeline reads, `computeQueryShape`, runs under the Workers runtime.
 *
 *   Workers refuse to compile WebAssembly from bytes.
 *   `@mailwoman/recognizer` resolves to its `workerd` entry and that entry imports the `.wasm` file.
 *
 *   The structural fields and known formats come back on the first call with no `init`.
 *
 *   Run with `yarn workspace @mailwoman/postcode test:workers`.
 */

import { expect, it } from "vitest"

import { computeQueryShape } from "#recognize/query-shape"

it("computes the structural fields and the known formats on the first call", () => {
	const shape = computeQueryShape("350 5th Ave, New York, NY 10118")

	expect(shape.characterClass).toBe("alphanumeric")
	expect(shape.segments.map(({ body }) => body)).toEqual(["350 5th Ave", "New York", "NY 10118"])
	expect(shape.regionAbbreviations).toEqual([{ start: 23, span: "NY" }])

	expect(shape.knownFormats.map(({ format, confidence }) => [format, confidence])).toEqual([
		["us_zip", 0.6],
		["fr_postcode", 0.6],
		["de_postcode", 0.6],
	])
})

it("reads a script other than Latin", () => {
	const shape = computeQueryShape("〒100-0001 東京都千代田区千代田1-1")

	expect(shape.scripts[0]?.script).toBe("Hani")
	expect(shape.knownFormats.map(({ format }) => format)).toEqual(["jp_postcode"])
})
