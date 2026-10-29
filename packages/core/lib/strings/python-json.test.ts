/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Expected strings were printed by CPython 3.12's `repr` and `json.dumps`.
 */

import { describe, expect, test } from "vitest"

import { asPythonFloat, pythonFloatRepr, pythonJSONDumps } from "#strings/python-json"

describe("pythonFloatRepr", () => {
	test.each([
		[1, "1.0"],
		[2.5, "2.5"],
		[1e-5, "1e-05"],
		[0.0001, "0.0001"],
		[1e16, "1e+16"],
		[1_234_567_890_123_456, "1234567890123456.0"],
		[1.5e-7, "1.5e-07"],
		[-0, "-0.0"],
		[0.1 + 0.2, "0.30000000000000004"],
		[123_456_789.125, "123456789.125"],
		[1e22, "1e+22"],
		[5e-324, "5e-324"],
	])("repr(%d)", (value, expected) => {
		expect(pythonFloatRepr(value)).toBe(expected)
	})
})

describe("pythonJSONDumps", () => {
	test("indent=2 with ensure_ascii", () => {
		const value = { b: [1, asPythonFloat(2), {}], a: { é: [] }, c: null, d: "x\u007Fy\u{1F600}" }

		expect(pythonJSONDumps(value, { indent: 2 })).toBe(
			[
				"{",
				'  "b": [',
				"    1,",
				"    2.0,",
				"    {}",
				"  ],",
				'  "a": {',
				'    "\\u00e9": []',
				"  },",
				'  "c": null,',
				'  "d": "x\\u007fy\\ud83d\\ude00"',
				"}",
			].join("\n")
		)
	})

	test("one line with sort_keys and ensure_ascii=False", () => {
		expect(pythonJSONDumps({ b: 1, a: [true, "é"] }, { sortKeys: true, ensureASCII: false })).toBe(
			'{"a": [true, "é"], "b": 1}'
		)
	})

	test("refuses an unmarked non-integer", () => {
		expect(() => pythonJSONDumps({ share: 0.5 })).toThrow(/asPythonFloat/)
	})
})
