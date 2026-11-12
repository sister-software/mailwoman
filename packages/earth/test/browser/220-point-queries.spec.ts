// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Point-shaped queries: a coordinate pair, a plus code, an H3 cell and a `wof:` id each answer from
 *   their own decoder rather than the classifier, and the gazette and trace pages explain the shapes they
 *   cannot read.
 */

import { expect, test } from "../e2e/index.ts"

test.describe("Point queries", () => {
	test("each shape places a marker with its own label, on one page load", async ({ demo }) => {
		await demo.goto("48.8584, 2.2945")
		await demo.submit()

		await test.step("coordinates", async () => {
			const { parsedRows, resolved } = await demo.readResult()

			expect(parsedRows.map((row) => row.tag)).toEqual(["coordinates"])
			expect(resolved["placetype"]).toBe("coordinates")
			demo.expectNear(await demo.readCoords(), { lat: 48.8584, lon: 2.2945 }, 0.001)
		})

		await test.step("a full plus code decodes to its cell", async () => {
			await demo.setAddress("8FVC9G8F+6X")
			await demo.submitForUpdate()

			const { parsedRows } = await demo.readResult()

			expect(parsedRows.map((row) => row.tag)).toEqual(["plus code"])
			demo.expectNear(await demo.readCoords(), { lat: 47.3656, lon: 8.5249 }, 0.001)
		})

		await test.step("an H3 cell decodes through the H3 reader", async () => {
			await demo.setAddress("8928308280fffff")
			await demo.submitForUpdate()

			const { parsedRows } = await demo.readResult()

			expect(parsedRows.map((row) => row.tag)).toEqual(["H3 cell"])
			demo.expectNear(await demo.readCoords(), { lat: 37.7767, lon: -122.4185 }, 0.01)
		})

		await test.step("a wof: id with a polygon is placed and outlined", async () => {
			await demo.setAddress("wof:85633793")
			await demo.submitForUpdate()

			const { resolved, markerCount } = await demo.readResult()

			expect(resolved["WOF id"]).toBe("85633793")
			expect(markerCount).toBeGreaterThan(0)
		})

		demo.console.assertNoFailEvents()
	})

	test("the gazette opens a wof: id's chain and sends a position to the map", async ({ page }) => {
		await page.goto("/gazette?q=wof%3A1880762729", { waitUntil: "domcontentloaded" })

		const placePanel = page.locator("[aria-label='Place']")

		await expect(placePanel).toContainText("England", { timeout: 90_000 })
		await expect(page).toHaveURL(/\/gazette\/1880762729/u)

		await page.getByLabel("Place name").fill("48.85, 2.29")
		await expect(page.locator("[aria-label='Results']")).toContainText("indexes names, not positions")
	})

	test("the trace workbench states that a point has no decode path", async ({ page }) => {
		await page.goto("/trace?q=48.8584%2C%202.2945", { waitUntil: "domcontentloaded" })

		await expect(page.getByRole("status").filter({ hasText: "not an address" })).toBeVisible({ timeout: 90_000 })
		await expect(page.getByRole("button", { name: "Trace" })).toBeDisabled()
	})
})
