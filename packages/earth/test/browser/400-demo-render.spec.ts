/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structural render baseline for the geocoder page: the map container is sized, the address field and its example
 *   chips are present, and the About control opens a sheet carrying the in-browser claim. A deterministic "the page
 *   renders correctly" guard, distinct from the cold-load spec, which asserts what the page does once the model lands.
 *
 *   The About copy is asserted through its control rather than on load: the chrome restructure moved that explainer
 *   into a sheet, so it mounts when the sheet opens rather than with the shell.
 */

import { expect, test } from "../e2e/index.ts"

test.describe("Demo — structural render", () => {
	test("paints the page shell, map, about box, and form on load", async ({ demo, page }) => {
		await demo.goto()

		// The full-viewport map container is present and sized.
		const mapBox = await page.locator(".maplibregl-map").boundingBox()
		expect(mapBox?.width ?? 0).toBeGreaterThan(0)
		expect(mapBox?.height ?? 0).toBeGreaterThan(0)

		// Address form: label and field. The pill carries no submit control — a `type="search"` field submits on Enter.
		// `exact` is required: `getByLabel` matches by substring, and the chrome names the search wrapper "Search
		// addresses" and the chip row "Example addresses", so a bare "Address" resolves to three elements.
		await expect(page.getByLabel("Address", { exact: true })).toBeVisible()
		await expect(page.locator("#mw-pipeline-input")).toBeVisible()

		// Example chips row.
		await expect(page.getByText("Try:")).toBeVisible()
		await expect(page.getByRole("button", { name: "Space Needle" })).toBeVisible()

		// The About explainer is a control in the map chrome, and its copy renders in the sheet that control opens —
		// `MapControlButton` carries its name as `aria-label` on an icon button, so the name is a label and not text.
		// Asserted LAST: the sheet it opens overlays the chrome the assertions above read.
		await expect(page.getByLabel("About this geocoder")).toBeVisible()
		await page.getByLabel("About this geocoder").click()
		await expect(page.getByText(/runs entirely in your browser/i)).toBeVisible()

		demo.console.assertNoFailEvents()
	})
})
