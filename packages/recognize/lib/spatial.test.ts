// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `spatial` family from text to a typed recognition, through the WebAssembly engine.
 *
 *   The grammars, validators and their rejection codes have their tests in the Rust crates.
 *   These tests hold the TypeScript boundary: the typed payloads, UTF-16 spans
 *   and the rule for trusting a recognition.
 */

import { describe, expect, it } from "vitest"

import { isDeterministicSpatial } from "#deterministic/spatial"
import { createRecognizer } from "#index"
import { spatial } from "#spatial"

const recognizer = createRecognizer([spatial])

function only(text: string, kind: string) {
	return recognizer.recognize(text).recognitions.find((recognition) => recognition.kind === kind)
}

describe("the Open Location Code", () => {
	it("reads a full code and a short code as typed payloads", () => {
		expect(only("764mvfq6+92p", "plus_code.token")?.validation).toEqual({
			status: "validated",
			payload: { full_code: "764MVFQ6+92P" },
		})

		expect(only("VFQ6+92P", "plus_code.token")?.validation).toEqual({
			status: "validated",
			payload: { short_code: "VFQ6+92P" },
		})
	})

	it("refuses an odd count of digits with a typed code", () => {
		expect(only("VFQ+92P", "plus_code.token")?.validation).toMatchObject({
			status: "rejected",
			rejection: { code: "invalid_prefix_length" },
		})
	})

	it("finds a code inside a longer text and not inside a longer run", () => {
		const text = "Managua, VFQ6+92P, Nicaragua"
		const found = only(text, "plus_code.token")

		expect(found).toMatchObject({ start: 9, end: 17, text: "VFQ6+92P" })
		expect(only("X764MVFQ6+92P", "plus_code.token")).toBeUndefined()
	})
})

describe("DIGIPIN", () => {
	it("reads the compact and the display form, and normalizes both", () => {
		expect(only("39j49ll8t4", "digipin.compact")?.validation).toEqual({
			status: "validated",
			payload: { code: "39J49LL8T4" },
		})

		expect(only("39j-49l-l8t4", "digipin.display")?.validation).toEqual({
			status: "validated",
			payload: { code: "39J49LL8T4" },
		})
	})

	it("does not read ten characters inside a longer text as a compact code", () => {
		expect(only("call 2345678923 now", "digipin.compact")).toBeUndefined()
	})
})

describe("GeoJSON", () => {
	it("carries the type, and the position of a point", () => {
		const text = ' {"type":"Point","coordinates":[2.2945,48.8584]} '

		expect(only(text, "geojson.object")?.validation).toEqual({
			status: "validated",
			payload: { type: "Point", latitude: 48.8584, longitude: 2.2945 },
		})
	})

	it("returns a typed rejection for a text that parses wrongly", () => {
		for (const [text, code] of [
			['{"type":"Point","coordinates":[2.2945,}', "malformed_json"],
			['{"type":"Point","coordinates":[200,1]}', "longitude_out_of_range"],
			['{"type":"Point","coordinates":[1,91]}', "latitude_out_of_range"],
			['{"type":"Point"}', "missing_member"],
		] as const) {
			expect(only(text, "geojson.object")?.validation).toMatchObject({ status: "rejected", rejection: { code } })
		}
	})

	it("is whole-input only and refuses a document past the family's input limit", () => {
		expect(only('x {"type":"Point","coordinates":[1,2]}', "geojson.object")).toBeUndefined()

		expect(() => recognizer.recognize(`{"type":"Point","coordinates":[1,2],"x":"${"a".repeat(70_000)}"}`)).toThrow(
			/65536/
		)
	})
})

describe("when a spatial recognition may be trusted", () => {
	it("trusts a validated whole-input code and not a candidate", () => {
		const trusted = (text: string, kind: string) => {
			const recognition = only(text, kind)

			return recognition ? isDeterministicSpatial(recognition, text) : null
		}

		expect(trusted("764MVFQ6+92P", "plus_code.token")).toBe(true)
		expect(trusted("VFQ+92P", "plus_code.token")).toBe(false)
		expect(trusted("39J-49L-L8T4", "digipin.display")).toBe(true)
		// An all-digit display form is also a phone number: the validator accepts it and the rule withholds trust.
		expect(only("234-567-8923", "digipin.display")?.validation.status).toBe("validated")
		expect(trusted("234-567-8923", "digipin.display")).toBe(false)
		expect(trusted("234-567-89T3", "digipin.display")).toBe(true)
		expect(trusted("2345678923", "digipin.compact")).toBe(false)
		expect(trusted("Managua, VFQ6+92P", "plus_code.token")).toBe(false)
	})
})
