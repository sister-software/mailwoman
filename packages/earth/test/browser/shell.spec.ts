/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shell smoke: every route serves the app, `?q=` pre-fills the query, the fake runtime completes a query, and the
 *   static deployment records exist. No model, no gazetteer, no tile is fetched.
 */

import { expect, test } from "@playwright/test"

test.describe("Mailwoman Earth shell", () => {
	test("/ renders the geocoder and the fake runtime completes a query", async ({ page }) => {
		await page.goto("/?q=90210")

		await expect(page.locator("main[data-route='geocoder']")).toBeVisible()
		await expect(page.locator("#mw-pipeline-input")).toHaveValue("90210")

		await page.locator("button[type='submit']").click()

		await expect(page.getByText("New York").first()).toBeVisible()
	})

	test("/debug and /trace serve the app", async ({ page }) => {
		await page.goto("/debug")
		await expect(page.locator("main[data-route='debug']")).toBeVisible()

		await page.goto("/trace")
		await expect(page.locator("main[data-route='trace']")).toBeVisible()
	})

	test("an unknown path is the not-found view, served by the SPA fallback", async ({ page }) => {
		const response = await page.goto("/demo")

		expect(response?.status()).toBe(200)
		await expect(page.getByTestId("not-found")).toBeVisible()
	})

	test("build.json, the manifest and the service worker are static assets", async ({ request }) => {
		const build = await request.get("/build.json")
		expect(build.status()).toBe(200)

		const info = (await build.json()) as { app: string; revision: string; buildTime: string }
		expect(info.app).toBe("mailwoman-earth")
		expect(info.revision.length).toBeGreaterThanOrEqual(7)
		expect(info.buildTime.endsWith("Z")).toBe(true)

		const manifest = await request.get("/manifest.webmanifest")
		expect(manifest.status()).toBe(200)
		expect(((await manifest.json()) as { id: string }).id).toBe("https://earth.mailwoman.ai/")

		const worker = await request.get("/service-worker.js")
		expect(worker.status()).toBe(200)
	})
})
