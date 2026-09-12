/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { comparePromotionOutputs } from "mailwoman/eval-harness/promotion/eval/compare"
import { join } from "path-ts"
import { afterAll, describe, expect, test } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function outputDirectory(name: string, includePerLocale = true): Promise<string> {
	const directory = fixtures.use(await temporaryDirectory(name)).path

	await makeDirectories(directory)

	await writeLocalJSONFile(
		{
			label: "v9.0.0-base",
			verdict: "PASS",
			results: { "us.city": { actual: 98.2, floor: 98, pass: true } },
			generated_at_dir: directory.toString(),
		},
		join(directory, "verdict.json")
	)

	if (includePerLocale) {
		await writeLocalJSONFile({ reports: [{ exactRate: 98.2 }] }, join(directory, "fp32-per-locale.json"))
	}

	await writeLocalTextFile("model.onnx md5: abc", join(directory, "provenance.txt"))

	return directory.toString()
}

describe("comparePromotionOutputs", () => {
	test("accepts equal semantic output when each run writes a different output directory", async () => {
		const baseline = await outputDirectory("promotion-compare-baseline-")
		const candidate = await outputDirectory("promotion-compare-candidate-")

		await expect(comparePromotionOutputs(baseline, candidate)).resolves.toEqual({ equal: true, differences: [] })
	})

	test("ignores the provenance receipt timestamp", async () => {
		const baseline = await outputDirectory("promotion-compare-provenance-time-baseline-")
		const candidate = await outputDirectory("promotion-compare-provenance-time-candidate-")
		await writeLocalTextFile("graded at 2026-09-12T02:00:00Z\nmodel.onnx md5: abc", join(baseline, "provenance.txt"))
		await writeLocalTextFile("graded at 2026-09-12T03:00:00Z\nmodel.onnx md5: abc", join(candidate, "provenance.txt"))

		await expect(comparePromotionOutputs(baseline, candidate)).resolves.toEqual({ equal: true, differences: [] })
	})

	test("ignores output paths and elapsed times in arena narration", async () => {
		const baseline = await outputDirectory("promotion-compare-arena-baseline-")
		const candidate = await outputDirectory("promotion-compare-arena-candidate-")

		for (const [directory, seconds] of [[baseline, "0.7"] as const, [candidate, "1.2"] as const]) {
			await makeDirectories(join(directory, "arenas"))

			await writeLocalTextFile(
				`Running harness...\n  50/69 (${seconds}s)\nDone in ${seconds}s\nWrote 69 results to ${directory}/arenas/libpostal.results.json`,
				join(directory, "arenas", "libpostal.stderr")
			)
		}

		await expect(comparePromotionOutputs(baseline, candidate)).resolves.toEqual({ equal: true, differences: [] })
	})

	test("names a changed score field", async () => {
		const baseline = await outputDirectory("promotion-compare-score-baseline-")
		const candidate = await outputDirectory("promotion-compare-score-candidate-")
		await writeLocalJSONFile({ reports: [{ exactRate: 98.1 }] }, join(candidate, "fp32-per-locale.json"))

		const comparison = await comparePromotionOutputs(baseline, candidate)

		expect(comparison.equal).toBe(false)

		expect(comparison.differences).toContainEqual({
			path: "fp32-per-locale.json.reports[0].exactRate",
			baseline: "98.2",
			candidate: "98.1",
		})
	})

	test("rejects a missing sidecar", async () => {
		const baseline = await outputDirectory("promotion-compare-sidecar-baseline-")
		const candidate = await outputDirectory("promotion-compare-sidecar-candidate-", false)

		const comparison = await comparePromotionOutputs(baseline, candidate)

		expect(comparison.differences).toContainEqual({
			path: "fp32-per-locale.json",
			baseline: "<present>",
			candidate: "<missing>",
		})
	})

	test("rejects a changed artifact provenance value", async () => {
		const baseline = await outputDirectory("promotion-compare-provenance-baseline-")
		const candidate = await outputDirectory("promotion-compare-provenance-candidate-")
		await writeLocalTextFile("model.onnx md5: def", join(candidate, "provenance.txt"))

		const comparison = await comparePromotionOutputs(baseline, candidate)

		expect(comparison.differences).toContainEqual({
			path: "provenance.txt",
			baseline: "model.onnx md5: abc",
			candidate: "model.onnx md5: def",
		})
	})
})
