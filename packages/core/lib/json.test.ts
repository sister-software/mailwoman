/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests `orderedJSON` against `JSON.stringify` on plain values and on the `Map` order it adds.
 */

import { describe, expect, it } from "vitest"

import { orderedJSON, prettyJSON, stringifyJSON } from "#json"

const PLAIN = {
	name: "Montréal",
	counts: [1, 2.5, 0, -3],
	nested: { empty: {}, list: [], flag: true, none: null, skipped: undefined },
	rows: [{ a: 1 }, { b: [null, "x"] }],
}

describe("orderedJSON", () => {
	it("prints a plain value as JSON.stringify does, on one line and indented", () => {
		expect(orderedJSON(PLAIN)).toBe(stringifyJSON(PLAIN))
		expect(orderedJSON(PLAIN, { indent: "\t" })).toBe(prettyJSON(PLAIN, false))
		expect(orderedJSON(PLAIN, { indent: 2 })).toBe(prettyJSON(PLAIN, false, 2))
		expect(orderedJSON([undefined, 1])).toBe(stringifyJSON([undefined, 1]))
	})

	it("keeps a Map's insertion order where an object would move integer-like keys first", () => {
		const centroids = new Map([
			["seoul", [126.97, 37.56]],
			["11110", [126.98, 37.57]],
			["0123", [1, 2]],
		])

		expect(orderedJSON(centroids)).toBe('{"seoul":[126.97,37.56],"11110":[126.98,37.57],"0123":[1,2]}')

		expect(stringifyJSON(Object.fromEntries(centroids))).toBe(
			'{"11110":[126.98,37.57],"seoul":[126.97,37.56],"0123":[1,2]}'
		)
	})

	it("sorts keys at every depth when asked", () => {
		expect(orderedJSON({ b: 1, a: { d: 2, c: 3 } }, { sortKeys: true })).toBe('{"a":{"c":3,"d":2},"b":1}')
	})
})
