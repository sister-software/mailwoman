// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The script reader over trimmed real `yarn lint`, `yarn health` and `mwops health all` output.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { parseScriptOutput } from "#check-kit/parsers/scripts"

async function fixture(name: string): Promise<string> {
	const { lines } = await readLocalJSONFile<{ lines: string[] }>(
		repoRootPath("test", "fixtures", "check-kit", `${name}.json`)
	)

	return lines.join("\n")
}

describe("parseScriptOutput", () => {
	it("names the failing scripts of a failing lint run and counts a Vale finding once across both configurations", async () => {
		const parsed = parseScriptOutput(await fixture("lint-failing"), 1)

		expect(parsed.parsed).toBe(true)
		expect(parsed.failingChecks.toSorted()).toEqual(["lint:oxfmt", "lint:prose", "lint:prose:code"])
		// Two files oxfmt would reformat and one Vale error.
		expect(parsed.errors).toBe(3)
		// Six distinct Vale warnings, of which the second configuration repeats five, and four oxlint warnings.
		expect(parsed.warnings).toBe(10)
		expect(parsed.errorLines.some((line) => line.includes("styles.NamesVerb"))).toBe(true)
	})

	it("names each failing repository-health check and counts its error diagnostics", async () => {
		const parsed = parseScriptOutput(await fixture("health-all-failing"), 1)

		expect(parsed.failingChecks).toEqual(["rights-chain", "spdx-header", "effects-register"])
		expect(parsed.errors).toBe(5)
	})

	it("reads a passing yarn health run as zero findings", async () => {
		const parsed = parseScriptOutput(await fixture("yarn-health-passing"), 0)

		expect(parsed).toMatchObject({ parsed: true, errors: 0, warnings: 0, failingChecks: [] })
	})

	it("counts TypeScript errors and reads empty tsc output as success only where that is the success form", () => {
		const failed = parseScriptOutput(
			"packages/core/lib/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
			2
		)

		expect(failed).toMatchObject({ parsed: true, errors: 1 })
		expect(parseScriptOutput("", 0, { emptyIsSuccess: true })).toMatchObject({ parsed: true, errors: 0 })
		expect(parseScriptOutput("", 0)).toMatchObject({ parsed: false, errors: null })
	})

	it("reports a failing exit that no line explains as unparsed rather than as zero errors", () => {
		const parsed = parseScriptOutput("✓ debt\nKilled\n", 137)

		expect(parsed.parsed).toBe(false)
		expect(parsed.errors).toBeNull()
		expect(parsed.reason).toContain("137")
		expect(parseScriptOutput("Killed\n", 137)).toMatchObject({ parsed: false, errors: null })
	})

	it("reports a Vale summary that disagrees with the findings read", () => {
		const parsed = parseScriptOutput(
			" a.ts\n 1:1  error  wrapped\n✖ 2 errors, 0 warnings and 0 suggestions in 1 file.\n",
			1
		)

		expect(parsed.parsed).toBe(false)
		expect(parsed.reason).toContain("Vale summary")
	})
})
