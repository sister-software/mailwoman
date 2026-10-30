/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { readFixtureLines } from "./byte-fallback.ts"

describe("readFixtureLines", () => {
	it("reads a JSONL fixture's raw, text or input field and a plain-text fixture's lines", async () => {
		await using scratch = await temporaryDirectory("fixture-lines-")
		const jsonl = scratch.path("f.jsonl").toString()
		const text = scratch.path("f.txt").toString()

		await writeLocalTextFile('{"raw": "foo"}\n{"text": "bar"}\n{"input": "baz"}\n\n{"raw": "qux"}\n', jsonl)
		await writeLocalTextFile("hello\n\nworld\n", text)

		await expect(readFixtureLines(jsonl)).resolves.toEqual(["foo", "bar", "baz", "qux"])
		await expect(readFixtureLines(text)).resolves.toEqual(["hello", "world"])
	})
})
