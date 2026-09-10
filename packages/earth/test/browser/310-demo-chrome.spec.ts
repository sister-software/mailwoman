/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The floating chrome's contract, at a desktop and a phone width.
 *
 *   Every assertion stands for a defect that reached earth.mailwoman.ai and was found by a person looking at the page:
 *   a side sheet that opened over the button that opened it, so there was no way to close it; a footer strip that
 *   covered the bottom sheet's last rows on a phone; a compass built, exported and mounted in no app; a sources
 *   popover clipped out of existence by the strip's own overflow; two panels sharing an edge.
 *
 *   None of them were reachable by the suites that already ran here, which assert what the geocoder ANSWERS and
 *   nothing about what the page SHOWS.
 *
 *   IT RUNS ON `?runtime=fake`. The chrome is the subject, and the canned runtime renders all of it and completes a
 *   query without fetching the 38 MB model — so this suite stays fast, and it keeps reporting on the chrome on a day
 *   the model's origin is throttling.
 */

import {
	expectCompassFollowsBearing,
	expectEverySheetControlCloses,
	expectNoChromeOverlap,
	expectNothingUnderTheFooter,
	expectReachable,
} from "@mailwoman/site-kit/playwright/chrome-contract"
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
		await expect(page.locator(".mw-map-sheet--bottom")).toBeVisible()

		await expectNothingUnderTheFooter(page)

		await page.setViewportSize({ width: 390, height: 844 })
		await expect(page.locator(".mw-map-sheet--bottom")).toBeVisible()
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

		// The panel is over the whole map, so the opening control is underneath it — its own close is the way out.
		await sheet.locator(".mw-map-sheet__close").click()
		await expect(sheet).toHaveCount(0)
	})

	test("the compass appears off north and returns the map to it", async ({ page }) => {
		await openChrome(page)

		await expectCompassFollowsBearing(page, "__mailwomanMapCanvas")
	})

	test("the sources button shows the credits where a reader can see them", async ({ page }) => {
		await openChrome(page)

		const sources = page.getByRole("button", { name: "Sources" })
		await sources.click()

		const popover = page.locator(".mw-map-footer__popover")

		// REACHABLE, not merely visible. The popover shipped in the DOM carrying the right credits while the footer
		// strip's own `overflow-x` clipped it away, and both a `textContent` read and a `toBeVisible` assertion passed
		// over that — a clipped element keeps its box. Only hit-testing tells the difference.
		await expectReachable(page, ".mw-map-footer__popover")
		await expect(popover).toContainText("OpenStreetMap")

		await sources.click()
		await expect(popover).toHaveCount(0)
	})
})
