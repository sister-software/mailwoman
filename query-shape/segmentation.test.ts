/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { segment } from "./segmentation.js"

describe("segment", () => {
	it("splits on commas", () => {
		const segs = segment("350 5th Ave, New York, NY 10118")
		expect(segs.map((s) => s.body)).toEqual(["350 5th Ave", "New York", "NY 10118"])
		expect(segs.map((s) => s.separator)).toEqual([null, "comma", "comma"])
		expect(segs.map((s) => s.index)).toEqual([0, 1, 2])
	})

	it("splits on newlines", () => {
		const segs = segment("Acme Corp\n350 5th Ave\nNew York, NY 10118")
		expect(segs.map((s) => s.body)).toEqual(["Acme Corp", "350 5th Ave", "New York", "NY 10118"])
		expect(segs.map((s) => s.separator)).toEqual([null, "newline", "newline", "comma"])
	})

	it("splits on tabs", () => {
		const segs = segment("Apt 4B\t350 5th Ave")
		expect(segs.map((s) => s.body)).toEqual(["Apt 4B", "350 5th Ave"])
		expect(segs[1].separator).toBe("tab")
	})

	it("treats semicolon as comma-equivalent", () => {
		const segs = segment("350 5th Ave; New York")
		expect(segs.map((s) => s.body)).toEqual(["350 5th Ave", "New York"])
		expect(segs[1].separator).toBe("comma")
	})

	it("trims whitespace inside segments but preserves span offsets", () => {
		const text = "350 5th Ave,   New York"
		const segs = segment(text)
		expect(segs[1].body).toBe("New York")
		// The trimmed segment should start at the 'N' position, not at the comma.
		expect(text[segs[1].span.start]).toBe("N")
	})

	it("returns one segment for a comma-free input", () => {
		const segs = segment("350 5th Ave New York NY 10118")
		expect(segs.length).toBe(1)
		expect(segs[0].separator).toBe(null)
	})

	it("returns empty for empty input", () => {
		expect(segment("")).toEqual([])
	})

	it("skips empty segments from consecutive commas", () => {
		const segs = segment("Foo,, Bar")
		expect(segs.map((s) => s.body)).toEqual(["Foo", "Bar"])
	})
})
