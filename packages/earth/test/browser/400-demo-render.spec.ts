/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Checks that the geocoder page renders its map, address field, example chips and About sheet.
 */

import { expect, test } from "../e2e/index.ts"

test.describe("Demo — structural render", () => {
	test("paints the page shell, map, about box, and form on load", async ({ demo, page }) => {
		await demo.goto()

		const mapBox = await page.locator(".maplibregl-map").boundingBox()
		expect(mapBox?.width ?? 0).toBeGreaterThan(0)
		expect(mapBox?.height ?? 0).toBeGreaterThan(0)

		// The label needs `exact` because `getByLabel` matches substrings.
		// "Search addresses" and "Example addresses" would also match a bare "Address".
		await expect(page.getByLabel("Address", { exact: true })).toBeVisible()
		await expect(page.locator("#mw-pipeline-input")).toBeVisible()

		// The chip row has no visible caption, so the test finds it by its `aria-label`.
		await expect(page.getByRole("group", { name: "Example addresses" })).toBeVisible()
		await expect(page.getByRole("button", { name: "Space Needle" })).toBeVisible()

		// The About button is an icon button with an `aria-label`.
		// The test opens it last because its sheet covers the elements checked above.
		await expect(page.getByLabel("About this geocoder")).toBeVisible()
		await page.getByLabel("About this geocoder").click()
		await expect(page.getByText(/runs entirely in your browser/i)).toBeVisible()

		demo.console.assertNoFailEvents()
	})
})
