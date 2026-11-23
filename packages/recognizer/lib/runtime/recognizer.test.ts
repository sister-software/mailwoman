// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The recognizer's prefix status through the WebAssembly engine: the statuses
 *   of a shape for a whole text, a beginning and a text that's no beginning,
 *   and the refusal of a text over a family's limit.
 */

import { describe, expect, it } from "vitest"

import { coordinates } from "#coordinates"
import { createRecognizer } from "#index"
import { primitives } from "#primitives"

const recognizer = createRecognizer([primitives, coordinates] as const)

function statusOf(text: string, kind: string): string | undefined {
	return recognizer.prefixStatus(text).find((entry) => entry.kind === kind)?.status
}

describe("prefixStatus", () => {
	it("reports a shape for each family it composes, with the family's ID", () => {
		const statuses = recognizer.prefixStatus("40.5,")

		expect(statuses.some((entry) => entry.family === "coordinates")).toBe(true)
		expect(statuses.every((entry) => entry.family === "primitives" || entry.family === "coordinates")).toBe(true)
	})

	it("tells a beginning from a match and from a dead text", () => {
		expect(statusOf("40.5,", "coordinate.decimal_pair")).toBe("viable")
		expect(["accepted", "accepted_and_extendable"]).toContain(statusOf("40.5, -74", "coordinate.decimal_pair"))
		expect(statusOf("zzz", "coordinate.decimal_pair")).toBe("dead")
	})

	it("reads text whose UTF-8 encoding is longer than its length", () => {
		expect(statusOf("40.5, -74é", "coordinate.decimal_pair")).toBe("dead")
	})

	it("refuses a text longer than a family admits, as a search does", () => {
		expect(() => recognizer.prefixStatus("1".repeat(70_000))).toThrow(RangeError)
	})
})
