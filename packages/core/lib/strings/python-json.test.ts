/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Expected strings were printed by CPython 3.12's `json.dumps`.
 */

import { describe, expect, test } from "vitest"

import { pythonJSONDumps } from "#strings/python-json"

describe("pythonJSONDumps", () => {
	test("one line with ensure_ascii", () => {
		expect(pythonJSONDumps(["osm-ru:114", "x\u007Fy\u{1F600}", "é"])).toBe(
			'["osm-ru:114", "x\\u007fy\\ud83d\\ude00", "\\u00e9"]'
		)
	})

	test("one line with sort_keys and ensure_ascii=False", () => {
		expect(pythonJSONDumps({ b: 1, a: [true, "é"], c: null }, { sortKeys: true, ensureASCII: false })).toBe(
			'{"a": [true, "é"], "b": 1, "c": null}'
		)
	})

	test("refuses a non-integer", () => {
		expect(() => pythonJSONDumps({ share: 0.5 })).toThrow(/not an integer/)
	})
})
