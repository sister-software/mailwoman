// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { findRawAngles, mdxAnglesCheck } from "#repo-health/markdown/mdx-angles"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

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

describe("mdxAnglesCheck", () => {
	const RAW = "# Latency\n\nThe parse stays <55 ms.\n"

	test("reports the page and line of a raw angle in a compiled docs page", async () => {
		await using context = await plantFixtureRepository({
			"docs/articles/latency.mdx": RAW,
			// A page outside the compiled roots is never parsed as MDX.
			"docs/records/latency.md": RAW,
		})

		const diagnostics = await mdxAnglesCheck.run(context)

		expect(diagnostics.map((diagnostic) => [diagnostic.file, diagnostic.line])).toEqual([
			["docs/articles/latency.mdx", 3],
		])
	})

	test("accepts the page once the comparison sits in inline code", async () => {
		await using context = await plantFixtureRepository({
			"docs/articles/latency.mdx": "# Latency\n\nThe parse stays `<55 ms`.\n",
		})

		await expect(mdxAnglesCheck.run(context)).resolves.toEqual([])
	})
})
