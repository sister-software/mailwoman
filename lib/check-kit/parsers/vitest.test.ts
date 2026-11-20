// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The Vitest readers over trimmed real runs: three local fast-suite failures, a CI slow-suite
 * log with two timeouts, and a JSON report in the shape Vitest's JSON reporter writes.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { parseVitestReport, parseVitestText } from "#check-kit/parsers/vitest"

async function fixture(name: string): Promise<string> {
	const { lines } = await readLocalJSONFile<{ lines: string[] }>(
		repoRootPath("test", "fixtures", "check-kit", `${name}.json`)
	)

	return lines.join("\n")
}

describe("parseVitestText", () => {
	it("names the failing test and its first error line in a local fast-suite run", async () => {
		const parsed = parseVitestText(await fixture("vitest-database-locked"))

		expect(parsed.parsed).toBe(true)

		expect(parsed.failingTests).toEqual([
			{
				file: "packages/corpus/lib/build.integration.test.ts",
				name: "buildCorpus end-to-end against wof-admin JSON-bundle fixture > keeps a refused source out of the synthetic rows fanned from it",
				firstErrorLine: "Error: database is locked",
			},
		])

		expect(parsed.totals?.files).toEqual({ passed: 1538, failed: 1, skipped: 21, total: 1560 })
		// The summary row's `1 expected fail` counts as passed.
		expect(parsed.totals?.tests).toEqual({ passed: 15_945, failed: 1, skipped: 110, total: 16_056 })
	})

	it("reads an assertion error as the first error line", async () => {
		const [fingerprint, weights] = [
			parseVitestText(await fixture("vitest-fingerprint")),
			parseVitestText(await fixture("vitest-missing-weights")),
		]

		expect(fingerprint.failingTests[0]?.file).toBe("lib/dev-mcp/weights-cache-setting.test.ts")
		expect(fingerprint.failingTests[0]?.firstErrorLine).toMatch(/^AssertionError: expected \[Function\] to throw/u)
		expect(weights.failingTests[0]?.file).toBe("packages/mailwoman/cli/commands/data/pull.integration.test.ts")
		expect(weights.failingTests[0]?.firstErrorLine).toMatch(/^AssertionError: \[resolver\] candidate-table backend/u)
	})

	it("reads a GitHub Actions log through its prefixes and color sequences", async () => {
		const parsed = parseVitestText(await fixture("vitest-ci-slow-timeouts"))

		expect(parsed.failingTests.map((test) => [test.file, test.firstErrorLine])).toEqual([
			["packages/corpus/lib/build.integration.test.ts", "Error: Test timed out in 15000ms."],
			["packages/mailwoman/cli/commands/pipeline-debug-cli.integration.test.ts", "Error: Test timed out in 20000ms."],
		])

		expect(parsed.failingTests[1]?.name).toBe(
			"parse --debug (runtime pipeline) > normalize records the offsetMap so consumers can map spans back to raw"
		)

		expect(parsed.totals?.files.failed).toBe(2)
	})

	it("reports unparsed output instead of zero failures", () => {
		const parsed = parseVitestText("Segmentation fault (core dumped)\n")

		expect(parsed.parsed).toBe(false)
		expect(parsed.errors).toBeNull()
		expect(parsed.reason).toContain("Test Files")
	})
})

describe("parseVitestReport", () => {
	// The fields Vitest's JSON reporter writes for one failing test, one skipped file and one file that failed to load.
	const report = {
		numFailedTests: 1,
		numTotalTests: 3,
		success: false,
		testResults: [
			{
				name: "/repo/lib/a.test.ts",
				status: "failed",
				message: "",
				assertionResults: [
					{ ancestorTitles: ["outer"], title: "passes", status: "passed", failureMessages: [] },
					{
						ancestorTitles: ["outer", "inner"],
						title: "fails",
						status: "failed",
						failureMessages: ["AssertionError: expected 1 to be 2\n    at lib/a.test.ts:9:3"],
					},
				],
			},
			{
				name: "/repo/lib/b.test.ts",
				status: "passed",
				message: "",
				assertionResults: [{ ancestorTitles: [], title: "later", status: "skipped", failureMessages: [] }],
			},
			{
				name: "/repo/lib/c.test.ts",
				status: "failed",
				message: "Failed to load url #missing (resolved id: #missing) in /repo/lib/c.test.ts",
				assertionResults: [],
			},
		],
	}

	it("reads each failing test with its file relative to the checkout", () => {
		const parsed = parseVitestReport(report, "/repo")

		expect(parsed.failingTests).toEqual([
			{ file: "lib/a.test.ts", name: "outer > inner > fails", firstErrorLine: "AssertionError: expected 1 to be 2" },
			{
				file: "lib/c.test.ts",
				name: null,
				firstErrorLine: "Failed to load url #missing (resolved id: #missing) in /repo/lib/c.test.ts",
			},
		])

		expect(parsed.totals).toEqual({
			files: { passed: 0, failed: 2, skipped: 1, total: 3 },
			tests: { passed: 1, failed: 1, skipped: 1, total: 3 },
		})
	})

	it("reports a report without test results as unparsed", () => {
		expect(parseVitestReport({ success: true }, "/repo")).toMatchObject({ parsed: false, errors: null })
	})
})
