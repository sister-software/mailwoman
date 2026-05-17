/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseGoldenLine, unreachableComponents, validateGoldenDir, validateGoldenFile } from "./golden.js"

const here = dirname(fileURLToPath(import.meta.url))
const goldenDir = resolve(here, "../../../data/eval/golden/v0.1.0")

let scratch: string
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-golden-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("parseGoldenLine", () => {
	it("accepts a well-formed entry", () => {
		const entry = parseGoldenLine('{"raw":"Paris","components":{"locality":"Paris"},"country":"FR","source":"golden"}')
		expect(entry.country).toBe("FR")
		expect(entry.components.locality).toBe("Paris")
	})

	it("rejects missing raw", () => {
		expect(() => parseGoldenLine('{"components":{},"country":"FR","source":"golden"}')).toThrow(/raw/)
	})

	it("rejects malformed country", () => {
		expect(() => parseGoldenLine('{"raw":"X","components":{},"country":"FRA","source":"golden"}')).toThrow(/alpha-2/)
		expect(() => parseGoldenLine('{"raw":"X","components":{},"country":"fr","source":"golden"}')).toThrow(/alpha-2/)
	})

	it("rejects unknown ComponentTag", () => {
		expect(() => parseGoldenLine('{"raw":"X","components":{"nonsense":"x"},"country":"FR","source":"golden"}')).toThrow(
			/unknown ComponentTag/
		)
	})

	it("rejects source != 'golden'", () => {
		expect(() => parseGoldenLine('{"raw":"X","components":{},"country":"FR","source":"wof-admin"}')).toThrow(
			/source must be/
		)
	})
})

describe("unreachableComponents", () => {
	it("returns empty when every component appears in raw", () => {
		const missing = unreachableComponents({
			raw: "Paris, France",
			components: { locality: "Paris", country: "France" },
			country: "FR",
			source: "golden",
		})
		expect(missing).toEqual([])
	})

	it("flags components missing from raw", () => {
		const missing = unreachableComponents({
			raw: "Paris",
			components: { locality: "Paris", region: "Île-de-France" },
			country: "FR",
			source: "golden",
		})
		expect(missing).toEqual(["region"])
	})
})

describe("validateGoldenFile", () => {
	it("flags both schema + reachability issues in one pass", async () => {
		const path = join(scratch, "test.jsonl")
		await writeFile(
			path,
			[
				'{"raw":"OK","components":{"locality":"OK"},"country":"FR","source":"golden"}',
				'{"raw":"missing-region","components":{"locality":"missing-region","region":"Île-de-France"},"country":"FR","source":"golden"}',
				'{"raw":"bad","components":{},"country":"fr","source":"golden"}',
				"",
			].join("\n"),
			"utf8"
		)
		const issues = await validateGoldenFile(path)
		expect(issues).toHaveLength(2)
		expect(issues[0]!.reason).toMatch(/components not reachable/)
		expect(issues[1]!.reason).toMatch(/alpha-2/)
	})
})

describe("validateGoldenDir against the in-repo seed set", () => {
	it("returns zero issues for data/eval/golden/v0.1.0", async () => {
		const report = await validateGoldenDir(goldenDir)
		// us.jsonl + fr.jsonl + adversarial.jsonl (Phase 1.6 §3)
		expect(report.files).toBe(3)
		expect(report.entries).toBeGreaterThanOrEqual(70)
		expect(report.issues).toEqual([])
	})
})
