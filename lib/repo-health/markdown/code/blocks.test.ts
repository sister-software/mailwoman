// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { extractCodeBlocks, replaceCodeBlocks } from "#repo-health/markdown/code/blocks"

describe("extractCodeBlocks", () => {
	test("returns lintable blocks with the page lines of their first and last content lines", () => {
		const source = [
			"# Page",
			"",
			"```sh",
			"npm install mailwoman",
			"```",
			"",
			"```ts",
			"const a = 1",
			"const b = 2",
			"```",
			"",
			"```tsx title=example.tsx",
			"export const B = () => null",
			"```",
		].join("\n")

		expect(extractCodeBlocks(source)).toEqual([
			{ index: 0, extension: "ts", firstLine: 8, lastLine: 9, indent: "", text: "const a = 1\nconst b = 2\n" },
			{ index: 1, extension: "tsx", firstLine: 13, lastLine: 13, indent: "", text: "export const B = () => null\n" },
		])
	})

	test("removes a list item's fence indentation and records it", () => {
		const source = ["1. Run it:", "", "   ```js", "   console.log(1)", "     nested()", "   ```"].join("\n")

		expect(extractCodeBlocks(source)).toEqual([
			{ index: 0, extension: "js", firstLine: 4, lastLine: 5, indent: "   ", text: "console.log(1)\n  nested()\n" },
		])
	})

	test("skips a fragment, keeps an inner shorter fence as content, and drops an unclosed block", () => {
		const source = [
			"```ts fragment",
			"partial(",
			"```",
			"````ts",
			"const inner = `",
			"```",
			"`",
			"````",
			"```ts",
			"never closed",
		].join("\n")

		expect(extractCodeBlocks(source)).toEqual([
			{ index: 0, extension: "ts", firstLine: 5, lastLine: 7, indent: "", text: "const inner = `\n```\n`\n" },
		])
	})
})

describe("replaceCodeBlocks", () => {
	test("writes a fixed block back with its indentation and leaves the rest of the page unchanged", () => {
		const source = [
			"Intro",
			"",
			"   ```ts",
			"   const a = 1",
			"   console.log(a)",
			"   ```",
			"",
			"```ts",
			"x()",
			"```",
			"",
		].join("\n")

		const fixed = replaceCodeBlocks(
			source,
			new Map([
				[0, "const a = 1\n\nconsole.log(a)\n"],
				[1, "x()\n"],
			])
		)

		expect(fixed).toBe(
			[
				"Intro",
				"",
				"   ```ts",
				"   const a = 1",
				"",
				"   console.log(a)",
				"   ```",
				"",
				"```ts",
				"x()",
				"```",
				"",
			].join("\n")
		)
	})
})
