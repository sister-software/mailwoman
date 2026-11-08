/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { contentRangeTotal, rangedResponseTotal } from "#api/content-range"

describe("contentRangeTotal", () => {
	it.each([
		["bytes 0-0/507006221", 507_006_221],
		["bytes 100-199/1000", 1000],
		["bytes */4096", 4096],
		["bytes 0-99/*", null],
		["", null],
		[null, null],
	])("reads %j as %j", (header, expected) => {
		expect(contentRangeTotal(header)).toBe(expected)
	})
})

describe("rangedResponseTotal", () => {
	it("prefers the Content-Range total over the offset plus Content-Length", () => {
		const response = new Response(null, { headers: { "content-range": "bytes 10-19/50", "content-length": "10" } })

		expect(rangedResponseTotal(response, 10)).toBe(50)
	})

	it("adds Content-Length to the offset when the response states no range", () => {
		expect(rangedResponseTotal(new Response(null, { headers: { "content-length": "40" } }), 10)).toBe(50)
	})

	it("returns null when the response states neither", () => {
		expect(rangedResponseTotal(new Response(null), 10)).toBeNull()
	})
})
