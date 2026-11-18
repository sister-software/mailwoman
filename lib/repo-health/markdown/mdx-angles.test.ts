// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { findRawAngles } from "#repo-health/markdown/mdx-angles"

describe("findRawAngles", () => {
	test("reports a raw angle before a digit and a raw brace before a letter in prose", () => {
		const source = [
			"Latency stays <55 ms.",
			"The {word} renders as an expression.",
			"A <Component /> and a <span> are valid.",
		].join("\n")

		expect(findRawAngles(source)).toEqual([
			{ line: 1, text: "Latency stays <55 ms." },
			{ line: 2, text: "The {word} renders as an expression." },
		])
	})

	test("skips inline code, double-backtick spans and fences of every shape", () => {
		const source = [
			"Write `<55` or ``a ` {word}`` inline.",
			"1. A list step:",
			"",
			"   ```ts",
			"   const a = {b: 1} < 2",
			"   ```",
			"~~~",
			"{tilde}",
			"~~~",
			"````md",
			"```",
			"{inner}",
			"```",
			"````",
		].join("\n")

		expect(findRawAngles(source)).toEqual([])
	})
})
