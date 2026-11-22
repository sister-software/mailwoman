// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { packageLicenseCheck } from "#repo-health/checks/package-license"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

const EXPRESSION = "AGPL-3.0-only OR LicenseRef-Commercial"

/**
 * A root declaring {@link EXPRESSION} with three workspaces, the third declaring `license`.
 */
function licensedTree(license: string | null) {
	return {
		"package.json": { name: "fixture", license: EXPRESSION, workspaces: ["packages/*"] },
		"packages/a/package.json": { name: "@fixture/a", license: EXPRESSION },
		"packages/b/package.json": { name: "@fixture/b", license: EXPRESSION },
		"packages/c/package.json": license === null ? { name: "@fixture/c" } : { name: "@fixture/c", license },
	}
}

describe("packageLicenseCheck", () => {
	it.each([
		["omits the commercial branch", "AGPL-3.0-only"],
		["declares a deprecated identifier", "AGPL-3.0 OR LicenseRef-Commercial"],
		["declares no license", null],
	])("reports the workspace that %s", async (_title, license) => {
		await using context = await plantFixtureRepository(licensedTree(license))

		const diagnostics = await packageLicenseCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["packages/c/package.json"])
	})

	it("accepts a tree whose workspaces all declare the root's expression", async () => {
		await using context = await plantFixtureRepository(licensedTree(EXPRESSION))

		await expect(packageLicenseCheck.run(context)).resolves.toEqual([])
	})
})
