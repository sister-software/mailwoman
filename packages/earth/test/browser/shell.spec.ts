/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Smoke-test application routes, query prefill, fake-runtime results, and static deployment assets without loading model data.
 */

import { expect, test } from "@playwright/test"

test.describe("Mailwoman Earth shell", () => {
	test("/ renders the geocoder and the fake runtime completes a query", async ({ page }) => {
		await page.goto("/?q=90210&runtime=fake")

		await expect(page.locator("main[data-route='geocoder']")).toBeVisible()
		await expect(page.locator("#mw-pipeline-input")).toHaveValue("90210")

		// The input submits on Enter; the magnifier is decorative.
		await page.locator("#mw-pipeline-input").press("Enter")

		await expect(page.getByText("New York").first()).toBeVisible()
	})

	test("the footer carries the docs link and the commit the build was made from", async ({ page }) => {
		// Check the real runtime footer; the fake runtime can hide a missing commit link.
		//
		// Block model and gazetteer downloads; the footer must render independently of data loading.
		await page.route("https://public.mailwoman.ai/**", (route) => route.abort())

		await page.goto("/")

		const footer = page.locator("footer, .mw-map-footer").first()

		await expect(footer.getByRole("link", { name: "Developer Documentation" })).toHaveAttribute(
			"href",
			"https://mailwoman.ai/docs"
		)

		// Validate the built commit URL's format without pinning a specific hash.
		const commit = footer.locator("a[href*='/commit/']")

		await expect(commit).toBeVisible()

		await expect(commit).toHaveAttribute(
			"href",
			/^https:\/\/github\.com\/sister-software\/mailwoman\/commit\/[0-9a-f]{40}$/
		)
	})

	test("/debug and /trace serve the app", async ({ page }) => {
		await page.goto("/debug?runtime=fake")
		await expect(page.locator("main[data-route='debug']")).toBeVisible()

		await page.goto("/trace?runtime=fake")
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

		const info = (await build.json()) as { app: string; revision: string; commit: string; buildTime: string }
		expect(info.app).toBe("mailwoman-earth")
		expect(info.revision.length).toBeGreaterThanOrEqual(7)
		expect(info.buildTime.endsWith("Z")).toBe(true)

		// The linked commit must be complete and match the abbreviated build revision.
		expect(info.commit).toHaveLength(40)
		expect(info.commit.startsWith(info.revision)).toBe(true)

		const manifest = await request.get("/manifest.webmanifest")
		expect(manifest.status()).toBe(200)
		expect(((await manifest.json()) as { id: string }).id).toBe("https://earth.mailwoman.ai/")

		const worker = await request.get("/service-worker.js")
		expect(worker.status()).toBe(200)
	})
})
