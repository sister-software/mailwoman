/**
 * @file `/debug` route + the in-demo model-visualizer drawer (operator's #941 integration). The debug drawer traces the
 *   SAME address geocoded on the map. Asserts: /debug opens with the drawer on, a parse populates the decode-path
 *   visualizer, and the plain / has no drawer until dev mode is toggled.
 */

import { expect, test } from "../e2e/index.ts"

test.describe("Demo — model-visualizer debug drawer", () => {
	test("/debug opens the drawer and traces the parsed address", async ({ demo, page }) => {
		// No trailing slash: the site builds debug.html, so /debug/ is a 404 status on Pages (the #1590 class).
		await page.goto("/debug", { waitUntil: "networkidle" })
		await demo.expectReady()
		await demo.setAddress("1600 Pennsylvania Ave NW, Washington, DC 20500")
		await demo.submit()

		const drawer = page.locator("aside[aria-label='Model decode-path visualizer']")
		await expect(drawer).toBeVisible({ timeout: 30_000 })
		// The visualizer renders the decode path — the input pieces show up in the drawer.
		await expect(drawer).toContainText("Pennsylvania", { timeout: 30_000 })
		demo.console.assertNoFailEvents()
	})

	test("/ has no drawer until dev mode is toggled", async ({ demo, page }) => {
		await demo.goto("Chicago, IL")
		await demo.submit()
		await expect(page.locator("aside[aria-label='Model decode-path visualizer']")).toHaveCount(0)

		// The trace toggle sits behind the Developer capsule in the map chrome and reads "Trace the decode path" — the
		// two display toggles moved there so they stop heading every result. Open that sheet, then check the box.
		await page.getByLabel("Developer controls").click()
		await page.getByLabel("Trace the decode path").check()
		await expect(page.locator("aside[aria-label='Model decode-path visualizer']")).toBeVisible({ timeout: 30_000 })
		demo.console.assertNoFailEvents()
	})
})
