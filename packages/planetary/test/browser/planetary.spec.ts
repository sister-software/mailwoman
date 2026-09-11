/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The smoke over a built body: the preview serves whichever body it was built for, and the spec reads it from
 *   `build.json` rather than assuming one. It reaches the real archives on `tiles.mailwoman.ai` and the search
 *   artifact on `public.mailwoman.ai`, so it needs the network, as the Earth production smoke does.
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

	// `FeaturePanel` rides `MapSheet` rather than carrying its own panel, so the selected feature is an `<aside>` the
	// sheet names for the feature — `aria-label={title}` with `title={feature.name}` — where it used to be an
	// `<article>` holding that name as text. Reading it by role and name asserts the panel is FOR this feature, which
	// the text match only implied.
	await expect(page).toHaveURL(/\/feature\/\d+$/u)
	await expect(page.getByRole("complementary", { name: known.name })).toBeVisible()

	await page.reload()
	await expect(page.getByRole("complementary", { name: known.name })).toBeVisible({ timeout: 60_000 })
})

test("an unknown path is the not-found view, not the globe", async ({ page }) => {
	await page.goto("/nowhere")
	await expect(page.getByTestId("not-found")).toBeVisible()
})

/**
 * MapLibre parses vector tiles and rasterizes glyph ranges inside a web worker; only raster tiles decode on the main
 * thread. So a worker that never runs leaves the hillshade drawing and every label missing, and it says nothing: the
 * worker's script URL is served by the SPA fallback as index.html at status 200, and parsing HTML as a module fails
 * inside the worker where no page listener sees it. These assertions read the two observable consequences.
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

	// A worker script answered with HTML is the SPA fallback standing in for an asset the build never emitted.
	for (const body of workerBodies) {
		expect(body.contentType, `${body.url} is served as HTML, so the worker cannot parse it`).not.toContain("text/html")
	}
})
