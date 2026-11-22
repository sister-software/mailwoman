// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { testLayoutCheck } from "#repo-health/checks/test-layout"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

const WORKSPACE = {
	"package.json": { name: "fixture", private: true, workspaces: ["packages/*"] },
	"packages/a/package.json": { name: "@fixture/a" },
	"packages/a/lib/parse.ts": "export const parse = (text: string) => text.trim()\n",
}

const TEST_SOURCE = 'import { test } from "vitest"\n\ntest("parses", () => {})\n'

describe("testLayoutCheck", () => {
	it("reports a test in a directory that holds no module", async () => {
		await using context = await plantFixtureRepository({
			...WORKSPACE,
			"packages/a/lib/parse.test.ts": TEST_SOURCE,
			"packages/a/lib/cases/parse.test.ts": TEST_SOURCE,
		})

		const diagnostics = await testLayoutCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["packages/a/lib/cases/parse.test.ts"])
	})

	it("reports a Playwright spec in a workspace that has no Playwright config", async () => {
		await using context = await plantFixtureRepository({
			...WORKSPACE,
			"packages/a/test/browser/page.spec.ts": TEST_SOURCE,
		})

		const diagnostics = await testLayoutCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["packages/a/test/browser/page.spec.ts"])
	})

	it("accepts a test beside its module and a spec under a suite of a Playwright workspace", async () => {
		await using context = await plantFixtureRepository({
			...WORKSPACE,
			"packages/a/lib/parse.test.ts": TEST_SOURCE,
			"packages/a/playwright.config.ts": "export default {}\n",
			"packages/a/test/browser/page.spec.ts": TEST_SOURCE,
		})

		await expect(testLayoutCheck.run(context)).resolves.toEqual([])
	})
})
