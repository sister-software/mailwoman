/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { snippet, SNIPPET_LENGTH } from "./snippet.ts"

describe("snippet", () => {
	test("returns short content whole with the range of each token match", () => {
		expect(snippet("The decoder reads a Decoder grammar.", ["decoder"])).toEqual({
			snippet: "The decoder reads a Decoder grammar.",
			highlights: [
				[4, 11],
				[20, 27],
			],
		})
	})

	test("windows long content around the first match and stays within the length", () => {
		const content = `${"lorem ".repeat(100)}needle ${"ipsum ".repeat(100)}`
		const result = snippet(content, ["needle"])
		const [start, end] = result.highlights[0]!

		expect(result.snippet.length).toBeLessThanOrEqual(SNIPPET_LENGTH)
		expect(result.snippet.slice(start, end)).toBe("needle")
	})

	test("returns the start of the content when no token occurs in it", () => {
		expect(snippet("a".repeat(500), ["zzz"])).toEqual({ snippet: "a".repeat(SNIPPET_LENGTH), highlights: [] })
	})

	test("returns an empty snippet for empty content", () => {
		expect(snippet("", ["x"])).toEqual({ snippet: "", highlights: [] })
	})

	test("ignores tokens that are empty after trimming punctuation", () => {
		expect(snippet("plain text", ['""']).highlights).toEqual([])
	})
})
