/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { measureByteFallback, readFixtureLines } from "./byte-fallback.ts"

/**
 * The 16,000-piece tokenizer committed as a test fixture.
 */
const MODEL = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model").toString()

describe("measureByteFallback", () => {
	it("counts every line and keeps each script's rate between 0 and 1", async () => {
		const report = await measureByteFallback(MODEL, [
			"Paris 75008",
			"Washington DC 20500",
			"東京都新宿区",
			"Москва Тверская",
		])

		expect(report.overall.lines).toBe(4)
		expect(report.overall.pieces).toBeGreaterThan(0)
		expect(Object.keys(report.per_script).length).toBeGreaterThan(1)

		for (const bucket of Object.values(report.per_script)) {
			expect(bucket.rate).toBeGreaterThanOrEqual(0)
			expect(bucket.rate).toBeLessThanOrEqual(1)
		}
	})

	it("reports zero lines, pieces and rate for no input", async () => {
		const report = await measureByteFallback(MODEL, [])

		expect(report.overall).toMatchObject({ lines: 0, pieces: 0, byte_fallback_pieces: 0, rate: 0 })
	})
})

describe("readFixtureLines", () => {
	it("reads a JSONL fixture's raw, text or input field and a plain-text fixture's lines", async () => {
		await using scratch = await temporaryDirectory("fixture-lines-")
		const jsonl = scratch.path("f.jsonl").toString()
		const text = scratch.path("f.txt").toString()

		await writeLocalTextFile('{"raw": "foo"}\n{"text": "bar"}\n{"input": "baz"}\n\n{"raw": "qux"}\n', jsonl)
		await writeLocalTextFile("hello\n\nworld\n", text)

		expect(await readFixtureLines(jsonl)).toEqual(["foo", "bar", "baz", "qux"])
		expect(await readFixtureLines(text)).toEqual(["hello", "world"])
	})
})
