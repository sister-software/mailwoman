/**
 * @file The `/gazette` explorer: a name search over the published browser gazetteer, and a place permalink that
 *   shows the place's ancestors and the record as the resolver reads it.
 */

import { expect, test } from "../e2e/index.ts"

test.describe("Gazette", () => {
	test("a permalink opens the place with its ancestors, and a search lists names", async ({
		console: consoleFixture,
		page,
	}) => {
		await page.goto("/gazette/1880762729/london", { waitUntil: "domcontentloaded" })

		const placePanel = page.locator("[aria-label='Place']")

		await expect(placePanel).toContainText("Greater London", { timeout: 90_000 })
		await expect(placePanel).toContainText("England")
		await expect(placePanel).toContainText("United Kingdom")

		await expect(placePanel.getByRole("link", { name: "Spelunker" })).toHaveAttribute(
			"href",
			"https://spelunker.whosonfirst.org/id/1880762729/"
		)

		await page.getByLabel("Place name").fill("uxbridge")

		const results = page.locator("[aria-label='Results']")

		await expect(results).toContainText("Uxbridge", { timeout: 60_000 })
		await expect(page).toHaveURL(/q=uxbridge/u)

		await results.getByRole("link").first().click()
		await expect(placePanel).toContainText("Uxbridge", { timeout: 60_000 })
		await expect(page).toHaveURL(/\/gazette\/\d+\/uxbridge/u)

		consoleFixture.assertNoFailEvents()
	})
})
