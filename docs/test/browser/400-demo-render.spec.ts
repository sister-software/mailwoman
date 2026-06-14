/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structural render baseline for the /demo page. Unlike the cold-load spec (which waits for the ~25
 *   MB model to finish loading before the submit button enables), this asserts the _static shell_
 *   paints correctly — header, intro copy, map container, the "About this demo" box, the address
 *   form, and the example chips — which all render immediately on hydration, before any heavy asset
 *   lands. A fast, deterministic "the page renders correctly" guard.
 */

import { expect, test } from "#e2e"

test.describe("Demo — structural render", () => {
	test("paints the page shell, map, about box, and form on load", async ({ demo, page }) => {
		await demo.goto()

		// Header + intro copy.
		await expect(page.getByRole("heading", { name: "Mailwoman geocoder demo" })).toBeVisible()
		await expect(page.getByText(/runs entirely in your browser/i)).toBeVisible()

		// The full-viewport map container is present and sized.
		const mapBox = await page.locator(".maplibregl-map").boundingBox()
		expect(mapBox?.width ?? 0).toBeGreaterThan(0)
		expect(mapBox?.height ?? 0).toBeGreaterThan(0)

		// Collapsible "About this demo" explainer.
		await expect(page.getByText("About this demo")).toBeVisible()

		// Address form: label, input, submit.
		await expect(page.getByLabel("Address")).toBeVisible()
		await expect(page.locator("#addr-input")).toBeVisible()
		await expect(page.locator("button[type='submit']")).toBeVisible()

		// Example chips row.
		await expect(page.getByText("Try:")).toBeVisible()
		await expect(page.getByRole("button", { name: "Empire State" })).toBeVisible()

		demo.console.assertNoFailEvents()
	})
})
