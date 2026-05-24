import { expect, test } from "#e2e"

test.describe("Demo — cold load", () => {
	test("hydrates without style / terrain / asset errors", async ({ demo }) => {
		await demo.goto()
		demo.console.assertNoFailEvents()
	})

	test("renders example chips + the form", async ({ demo, page }) => {
		await demo.goto()
		await expect(page.locator("button[type='submit']")).toBeVisible()
		await expect(page.locator("#addr-input")).toHaveValue("1600 Pennsylvania Ave NW, Washington, DC 20500")
		await expect(page.locator("button:has-text('White House')")).toBeVisible()
		await expect(page.locator("button:has-text('ZIP only')")).toBeVisible()
	})
})
