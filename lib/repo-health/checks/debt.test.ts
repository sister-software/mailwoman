// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { describe, expect, it } from "vitest"

import { checkPassed } from "#repo-health/check"
import { BASELINE_PATH, debtCheck, type DebtCounters } from "#repo-health/checks/debt"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

const MODULE = "packages/a/lib/narrow.ts"

/**
 * A one-workspace tree whose module holds `casts` casts to `never`, one per line from line 1.
 *
 * The check compares a fixture's counters with the committed baseline of this repository.
 */
function treeWithNeverCasts(casts: number) {
	const lines = Array.from({ length: casts }, (_, index) => `export const value${index} = ${index} as never`)

	return {
		"package.json": { name: "fixture", private: true, workspaces: ["packages/*"] },
		"packages/a/package.json": { name: "@fixture/a" },
		[MODULE]: [...lines, ""].join("\n"),
	}
}

describe("debtCheck", () => {
	it("reports a counter that grew past its baseline, with the sites that hold it", async () => {
		const baseline = await readLocalJSONFile<DebtCounters>(BASELINE_PATH)

		await using context = await plantFixtureRepository(treeWithNeverCasts(baseline.asNever + 1))

		const diagnostics = await debtCheck.run(context)
		const grown = diagnostics.filter((diagnostic) => diagnostic.message.includes("asNever"))

		expect(checkPassed(diagnostics)).toBe(false)
		expect(grown).toHaveLength(1)
		expect(grown[0]!.details).toContain(`${MODULE}:1`)
	})

	it("passes a tree whose counters all sit at or below the baseline", async () => {
		await using context = await plantFixtureRepository(treeWithNeverCasts(0))

		expect(checkPassed(await debtCheck.run(context))).toBe(true)
	})
})
