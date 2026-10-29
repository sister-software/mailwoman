/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pins the PyYAML 6.0.3 scalar resolution the config reader reproduces, and Python's `repr`.
 *
 *   Each expectation is the value `yaml.safe_load` returns for the scalar, read on the lab host.
 */

import { describe, expect, it } from "vitest"

import { parsePythonYAML, pythonRepr, type PythonMapping } from "#training/config/python-yaml"

const value = (scalar: string) => (parsePythonYAML(`v: ${scalar}\n`) as PythonMapping).get("v")

describe("parsePythonYAML", () => {
	it.each([
		["NO", false],
		["no", false],
		["Off", false],
		["yes", true],
		["ON", true],
		["TRUE", true],
		["y", "y"],
		["n", "n"],
	])("reads %s as PyYAML does", (scalar, expected) => {
		expect(value(scalar)).toBe(expected)
	})

	it.each([
		["5e-4", "5e-4"],
		["1.0e3", "1.0e3"],
		["1e3", "1e3"],
		["1.0e+3", 1000],
		["2.5e-1", 0.25],
		[".5", 0.5],
		["1.", 1],
		["1_0.0", 10],
		["1:30.5", 90.5],
		["-.inf", Number.NEGATIVE_INFINITY],
	])("reads %s as a float or a string as PyYAML does", (scalar, expected) => {
		expect(value(scalar)).toBe(expected)
	})

	it.each([
		["1_000", 1000n],
		["010", 8n],
		["0x1f", 31n],
		["0b101", 5n],
		["-0b1", -1n],
		["1:30", 90n],
		["0", 0n],
		["09", "09"],
		["0o7", "0o7"],
	])("reads %s as an int or a string as PyYAML does", (scalar, expected) => {
		expect(value(scalar)).toBe(expected)
	})

	it("keeps a bare NO key as the boolean false and a quoted one as a string", () => {
		const weights = (parsePythonYAML('w:\n  NO: 1.0\n  "NO": 2.0\n') as PythonMapping).get("w") as PythonMapping

		expect([...weights.keys()]).toEqual([false, "NO"])
	})

	it("keeps a repeated key at its first position with its last value", () => {
		const mapping = parsePythonYAML("a: 1\nb: 2\na: 3\n") as PythonMapping

		expect([...mapping]).toEqual([
			["a", 3n],
			["b", 2n],
		])
	})

	it("reads a merge key", () => {
		const mapping = parsePythonYAML("m:\n  <<: {a: 1, b: 2}\n  b: 3\n") as PythonMapping

		expect([...(mapping.get("m") as PythonMapping)]).toEqual([
			["a", 1n],
			["b", 3n],
		])
	})

	it("refuses a timestamp and a bare =, which PyYAML constructs as a date or cannot construct", () => {
		expect(() => parsePythonYAML("v: 2026-10-29\n")).toThrow("timestamp")
		expect(() => parsePythonYAML("v: =\n")).toThrow("tag:yaml.org,2002:value")
		expect(value("2026-10-29T10:00")).toBe("2026-10-29T10:00")
	})
})

describe("pythonRepr", () => {
	it.each([
		[0.0005, "0.0005"],
		[1e-5, "1e-05"],
		[1, "1.0"],
		[1e16, "1e+16"],
		[123_456_789_012_345.6, "123456789012345.6"],
		[-0, "-0.0"],
		[Number.NaN, "nan"],
	])("writes the float %s as %s", (input, expected) => {
		expect(pythonRepr(input)).toBe(expected)
	})

	it("quotes strings as Python does", () => {
		expect(pythonRepr("po_box")).toBe("'po_box'")
		expect(pythonRepr("it's")).toBe(`"it's"`)
		expect(pythonRepr(["B-x", ""])).toBe("['B-x', '']")
		expect(pythonRepr(7n)).toBe("7")
		expect(pythonRepr(null)).toBe("None")
	})
})
