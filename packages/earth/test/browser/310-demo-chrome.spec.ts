/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The floating chrome's interface, at a desktop and a phone width, running on the canned `?runtime=fake` so no model is fetched and the suite stays fast.
 */

import {
	expectCompassFollowsBearing,
	expectEverySheetControlCloses,
	expectNoChromeOverlap,
	expectNothingUnderTheFooter,
	expectPointerQueriesStayScoped,
	expectReachable,
} from "@mailwoman/site-kit/playwright/chrome-interface"
import { expect, test } from "@playwright/test"

/**
 * The canned runtime, with a query already in the field so a submit needs no typing.
 */
const CHROME_URL = "/?runtime=fake&q=350%205th%20Ave%2C%20New%20York"

async function openChrome(page: import("@playwright/test").Page): Promise<void> {
	await page.goto(CHROME_URL)
	await expect(page.locator(".mw-map-searchbar")).toBeVisible()
}

test.describe("Chrome — the floating controls", () => {
	test("nothing overlaps, at a desktop width or a phone width", async ({ page }) => {
		await openChrome(page)
		await expectNoChromeOverlap(page)

		await page.setViewportSize({ width: 390, height: 844 })
		await expect(page.locator(".mw-map-searchbar")).toBeVisible()
		await expectNoChromeOverlap(page)
	})

	test("a result sheet never ends under the footer", async ({ page }) => {
		await openChrome(page)
		await page.locator("#mw-pipeline-input").press("Enter")
		await expect(page.locator(".mw-map-panel__result")).toBeVisible()

		await expectNothingUnderTheFooter(page)

		await page.setViewportSize({ width: 390, height: 844 })
		await expect(page.locator(".mw-map-panel__result")).toBeVisible()
		await expectNothingUnderTheFooter(page)
	})

	test("every control that opens a sheet closes it, from the sheet and from itself", async ({ page }) => {
		await openChrome(page)

		const exercised = await expectEverySheetControlCloses(page)

		expect(exercised.length, "at least one control opens a sheet").toBeGreaterThan(0)
	})

	test("a sheet stays dismissable at a phone width, where it covers the control that opened it", async ({ page }) => {
		await openChrome(page)
		await page.setViewportSize({ width: 390, height: 844 })

		const about = page.getByRole("button", { name: "About this geocoder" })
		await about.click()

		const sheet = page.locator(".mw-map-sheet--side")
		await expect(sheet).toBeVisible()

		// The panel covers the whole map, so the opening control is underneath it and its own close is the way out.
		await sheet.locator(".mw-map-sheet__close").click()
		await expect(sheet).toHaveCount(0)
	})

	test("the compass appears off north and returns the map to it", async ({ page }) => {
		await openChrome(page)

		await expectCompassFollowsBearing(page, "__mailwomanMapCanvas")
	})

	test("a pointer move never queries every layer in the style", async ({ page }) => {
		// The real basemap, because the canned runtime's style carries no label layers
		// (the hook returns before querying, so a pass there would prove no defect);
		// the basemap arrives well before the model, so this waits on the style having layers
		// rather than on the geocoder being ready.
		await page.goto("/")

		await page.waitForFunction(
			() => {
				const map = Reflect.get(globalThis, "__mailwomanMapCanvas") as
					| { getStyle(): { layers?: unknown[] } | undefined }
					| undefined

				return (map?.getStyle()?.layers?.length ?? 0) > 10
			},
			undefined,
			{ timeout: 120_000 }
		)

		await expectPointerQueriesStayScoped(page, "__mailwomanMapCanvas")
	})

	test("the bundled stylesheet keeps both halves of every vendor pair", async ({ page, request }) => {
		await openChrome(page)

		// The minifier collapses two declarations carrying the same value and keeps the last,
		// so a standard property written before its `-webkit-` twin is dropped from the output
		// while the source still reads correctly, and this is the only place that difference is visible.
		const href = await page.locator('link[rel="stylesheet"]').first().getAttribute("href")

		expect(href, "the page links a stylesheet").not.toBeNull()

		const css = await (await request.get(href!)).text()

		for (const property of ["backdrop-filter", "mask-image"]) {
			const prefixed = css.split(`-webkit-${property}:`).length - 1

			if (prefixed === 0) continue

			// `-webkit-x:` also contains `x:`, so the standard count is the raw count minus the prefixed ones.
			const standard = css.split(`${property}:`).length - 1 - prefixed

			expect(standard, `${property} survived the bundle beside its -webkit- twin`).toBeGreaterThanOrEqual(prefixed)
		}
	})

	test("the sources button shows the credits where a reader can see them", async ({ page }) => {
		await openChrome(page)

		const sources = page.getByRole("button", { name: "Sources" })
		await sources.click()

		const popover = page.locator(".mw-map-footer__popover")

		// A clipped element keeps its box, so only hit-testing distinguishes a reachable
		// popover from one merely present in the DOM.
		await expectReachable(page, ".mw-map-footer__popover")
		await expect(popover).toContainText("OpenStreetMap")

		await sources.click()
		await expect(popover).toHaveCount(0)
	})
})
