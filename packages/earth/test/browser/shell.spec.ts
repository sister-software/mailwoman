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
		await page.goto("/?q=90210&runtime=fake")

		await expect(page.locator("main[data-route='geocoder']")).toBeVisible()
		await expect(page.locator("#mw-pipeline-input")).toHaveValue("90210")

		// The search pill carries no submit button, the way the reference map apps carry none: the field submits on
		// Enter, and the leading magnifier is a mark rather than a control.
		await page.locator("#mw-pipeline-input").press("Enter")

		await expect(page.getByText("New York").first()).toBeVisible()
	})

	test("the footer carries the docs link and the commit the build was made from", async ({ page }) => {
		// The real runtime's footer, not the canned one's. The app mounts two, and when each built its own the commit
		// link went into the fake path and rendered nowhere a visitor could see it — a smoke that checked the canned
		// footer would have passed the whole time. `?runtime=fake` is absent here for that reason.
		//
		// The data origin is refused for the whole page so no model or gazetteer byte is fetched: the origin throttles
		// on download count and the rest of this suite spends that budget on results. Refusing it also states the
		// requirement more sharply than a successful load would — the identity strip is the page's own chrome, so it
		// must render before, during and after a load that never finishes.
		await page.route("https://public.mailwoman.ai/**", (route) => route.abort())

		await page.goto("/")

		const footer = page.locator("footer, .mw-map-footer").first()

		await expect(footer.getByRole("link", { name: "Developer Documentation" })).toHaveAttribute(
			"href",
			"https://mailwoman.ai/docs"
		)

		// The commit link resolves against build.json, which only a built deployment serves — so this asserts the shape
		// rather than a particular sha.
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

		// The footer links this one, so it has to be a whole sha and the same revision `revision` abbreviates —
		// a link built from a different commit than the page was built from is worse than no link.
		expect(info.commit).toHaveLength(40)
		expect(info.commit.startsWith(info.revision)).toBe(true)

		const manifest = await request.get("/manifest.webmanifest")
		expect(manifest.status()).toBe(200)
		expect(((await manifest.json()) as { id: string }).id).toBe("https://earth.mailwoman.ai/")

		const worker = await request.get("/service-worker.js")
		expect(worker.status()).toBe(200)
	})
})
