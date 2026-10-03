import { expect, test } from "@playwright/test"

test("the search modal returns a hit for a reference page", async ({ page }) => {
	await page.goto("/")
	await page.keyboard.press("Control+k")

	const dialog = page.locator("dialog.mw-search")

	await expect(dialog).toBeVisible()

	const input = dialog.getByRole("combobox")

	await expect(input).toBeFocused()
	await input.fill("locales and tiers")

	const first = dialog.getByRole("option").first()

	await expect(first).toContainText("Locales and tiers")
	await first.click()
	await expect(page).toHaveURL(/\/docs\/developers\/reference\/locales-and-tiers/)
})

test("a misspelled query shows the corrected text", async ({ page }) => {
	await page.goto("/")
	await page.keyboard.press("Control+k")
	await page.locator("dialog.mw-search").getByRole("combobox").fill("vitrebi")
	await expect(page.locator(".mw-search__corrected")).toContainText("viterbi")
})
