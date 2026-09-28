/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The smoke over a built body: the preview serves whichever body it was built for, read from `build.json`
 *   rather than assumed, and the spec reaches the real archives so it needs the network.
 */

import { expect, test } from "@playwright/test"

const KNOWN = {
	moon: { query: "tycho", name: "Tycho" },
	mars: { query: "olympus", name: "Olympus Mons" },
} as const

test("the globe loads for the built body, search finds a known feature, selection sets the URL and survives reload", async ({
	page,
	request,
}) => {
	const info = (await (await request.get("/build.json")).json()) as { app: string }
	const body = info.app.replace("mailwoman-", "") as keyof typeof KNOWN
	const known = KNOWN[body]

	expect(known, `build.json names ${info.app}`).toBeDefined()

	await page.goto("/")
	await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible()
	await expect(page.locator("main[data-search='ready']")).toBeVisible({ timeout: 60_000 })

	await page.getByRole("combobox").fill(known.query)

	await page
		.getByRole("option", { name: new RegExp(known.name, "u") })
		.first()
		.click()

	// Read the panel by role and name so the assertion is that it is FOR this feature, which a text match
	// only implied.
	await expect(page).toHaveURL(/\/feature\/\d+$/u)
	await expect(page.getByRole("complementary", { name: known.name })).toBeVisible()

	await page.reload()
	await expect(page.getByRole("complementary", { name: known.name })).toBeVisible({ timeout: 60_000 })
})

test("an unknown path is the not-found view, not the globe", async ({ page }) => {
	await page.goto("/nowhere")
	await expect(page.getByTestId("not-found")).toBeVisible()
})

test("the footer carries the docs link and the commit the build was made from", async ({ page }) => {
	// Both archive origins are refused so the identity strip must render before, during and after a load
	// that never finishes.
	await page.route("https://tiles.mailwoman.ai/**", (route) => route.abort())
	await page.route("https://public.mailwoman.ai/**", (route) => route.abort())

	await page.goto("/")

	const footer = page.locator(".attribution").first()

	await expect(footer.getByRole("link", { name: "Developer Documentation" })).toHaveAttribute(
		"href",
		"https://mailwoman.ai/docs"
	)

	// The commit link resolves against `build.json`, which only a built deployment serves, so assert its
	// shape rather than a particular sha.
	const commit = footer.locator("a[href*='/commit/']")

	await expect(commit).toBeVisible()

	await expect(commit).toHaveAttribute(
		"href",
		/^https:\/\/github\.com\/sister-software\/mailwoman\/commit\/[0-9a-f]{40}$/
	)
})

/**
 * MapLibre parses vector tiles and rasterizes glyph ranges inside a web worker, so a worker that never runs
 * leaves the hillshade drawing and every label missing with no page-visible error.
 *
 * These assertions read the two observable consequences.
 */
test("the map worker runs: nomenclature tiles and glyph ranges are requested", async ({ page }) => {
	const vectorTiles: string[] = []
	const glyphRanges: string[] = []
	const workerBodies: Array<{ url: string; contentType: string | null }> = []

	page.on("request", (request) => {
		const url = request.url()

		if (url.endsWith(".mvt")) {
			vectorTiles.push(url)
		}

		if (url.includes("/fonts/") && url.endsWith(".pbf")) {
			glyphRanges.push(url)
		}
	})

	page.on("response", async (response) => {
		if (!/worker/iu.test(response.url())) return

		workerBodies.push({ url: response.url(), contentType: response.headers()["content-type"] ?? null })
	})

	await page.goto("/")
	await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible()

	await expect
		.poll(() => vectorTiles.length, { timeout: 60_000, message: "no nomenclature vector tile was requested" })
		.toBeGreaterThan(0)

	await expect
		.poll(() => glyphRanges.length, { timeout: 60_000, message: "no glyph range was requested, so no label drew" })
		.toBeGreaterThan(0)

	// A worker script answered with html is the SPA fallback standing in for an asset the build never emitted.
	for (const body of workerBodies) {
		expect(body.contentType, `${body.url} is served as HTML, so the worker cannot parse it`).not.toContain("text/html")
	}
})
