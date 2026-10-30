/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { beforeAll, describe, expect, it } from "vitest"

import { mtfTokenizerBinary } from "./binary.ts"
import { measureByteFallback } from "./byte-fallback.ts"

/**
 * The 16,000-piece tokenizer committed as a test fixture.
 */
const MODEL = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model").toString()

describe("measureByteFallback", () => {
	// The first call compiles `mtf-tokenizer` when the checkout has no current build.
	beforeAll(async () => {
		await mtfTokenizerBinary()
	}, 600_000)

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
