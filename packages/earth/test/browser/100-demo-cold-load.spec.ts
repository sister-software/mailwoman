// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "../e2e/index.ts"

test.describe("Demo — cold load", () => {
	test("hydrates without style / terrain / asset errors", async ({ demo }) => {
		await demo.goto()
		demo.console.assertNoFailEvents()
	})

	test("renders example chips + an empty form", async ({ demo, page }) => {
		await demo.goto()
		await expect(page.locator("#mw-pipeline-input")).toHaveValue("")
		await expect(page.locator("#mw-pipeline-input")).toHaveAttribute("spellcheck", "false")
		await expect(page.locator("button:has-text('White House')")).toBeVisible()
		await expect(page.locator("button:has-text('ZIP only')")).toBeVisible()
	})
})
