import { expect, type Locator, type Page, test } from "@playwright/test"

/**
 * Opens the search modal with the keyboard shortcut.
 *
 * The shortcut listener attaches when React hydrates the navbar, which can be after `goto` returns.
 * The press is therefore retried until the dialog is open.
 */
async function openSearch(page: Page): Promise<Locator> {
	await page.goto("/", { waitUntil: "networkidle" })

	const dialog = page.locator("dialog.mw-search")

	await expect(async () => {
		await page.keyboard.press("Control+k")
		await expect(dialog).toBeVisible({ timeout: 1000 })
	}).toPass({ timeout: 20_000 })

	return dialog
}

test("the search modal returns a hit for a reference page", async ({ page }) => {
	const dialog = await openSearch(page)
	const input = dialog.getByRole("combobox")

	await expect(input).toBeFocused()
	await input.fill("locales and tiers")

	const first = dialog.getByRole("option").first()

	await expect(first).toContainText("Locales and tiers")
	await first.click()
	await expect(page).toHaveURL(/\/docs\/developers\/reference\/locales-and-tiers/)
})

test("a misspelled query shows the corrected text", async ({ page }) => {
	const dialog = await openSearch(page)

	await dialog.getByRole("combobox").fill("vitrebi")
	await expect(page.locator(".mw-search__corrected")).toContainText("viterbi")
})
