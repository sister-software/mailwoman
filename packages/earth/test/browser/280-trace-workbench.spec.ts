/**
 * @file The `/trace` workbench. The top field traces as it is typed, the character band and the readings
 *   follow, the URL keeps the traced text, and a tile's removal rewrites the traced text.
 */

import { expect, test } from "../e2e/index.ts"

test.describe("Trace workbench", () => {
	test("/trace traces the typed text and follows a tile removal", async ({ console: consoleFixture, page }) => {
		// domcontentloaded suffices: the classifier load keeps the network busy past readiness,
		// and the first "Last trace" line below is the real signal.
		await page.goto("/trace?q=10%20Downing%20St%2C%20London%20SW1A%202AA", { waitUntil: "domcontentloaded" })

		const field = page.getByLabel("Address to trace")

		await expect(field).toBeVisible({ timeout: 90_000 })
		await expect(field).toHaveValue("10 Downing St, London SW1A 2AA")
		await expect(page.getByText(/Last trace \d+ ms/u)).toBeVisible({ timeout: 90_000 })

		const band = page.locator("[aria-label='Characters by label']")

		await expect(band).toContainText("Downing")
		await expect(page.locator("[aria-label='Readings']")).toContainText("Predictability")

		await field.fill("Little Britain Lake, Uxbridge")
		await expect(band).toContainText("Uxbridge", { timeout: 30_000 })
		await expect(page).toHaveURL(/q=Little/u)

		await page.getByRole("button", { name: "Remove Uxbridge" }).click()
		await expect(field).toHaveValue("Little Britain Lake,")
		await expect(band).not.toContainText("Uxbridge", { timeout: 30_000 })

		consoleFixture.assertNoFailEvents()
	})
})
