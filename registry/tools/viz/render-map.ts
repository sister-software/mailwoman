/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a {@link toMapHTML} page (MapLibre GL + Protomaps basemap) to a PNG via headless Chromium
 *   — the shared map renderer behind the `registry viz` map figures (an internal helper, not a
 *   command).
 *
 *   Two house-stack constraints make this fiddlier than the Plotly/SVG renderers:
 *
 *   - MapLibre needs a real WebGL context → ANGLE's SwiftShader software rasterizer (the same flags the
 *       3D Plotly render uses).
 *   - The basemap tiles come from `tiles.sister.software`, which CORS-restricts to localhost + the docs
 *       domains — so the page MUST be SERVED OVER LOCALHOST, not opened as a file (a file:// page
 *       renders accurate markers on a blank basemap). Serve the output dir first, e.g. `python3 -m
 *       http.server 8899 -d <dir>`, then point this at `http://localhost:8899/<page>.html`.
 *
 *   The map paints asynchronously after the network settles; we wait for networkidle, then a fixed
 *   beat for the basemap tiles + marker layer to finish compositing.
 *
 *   Playwright (headless Chromium) is a heavy dev-only dependency — lazy-imported inside the entry
 *   fn (the corpus-tools lazy-import convention).
 */

/** Options for {@linkcode renderServedMapToPNG}. */
export interface RenderMapOptions {
	/** The served localhost URL of the map page (NOT a file:// path — see the module doc). */
	url: string
	/** Output PNG path. */
	outPNG: string
}

/** Screenshot a served MapLibre map page once the tiles + marker layer settle. */
export async function renderServedMapToPNG(
	options: RenderMapOptions,
	report?: (line: string) => void
): Promise<{ outPNG: string; consoleErrors: string[] }> {
	// playwright + Chromium are heavy — lazy import (the pipeline convention).
	const { chromium } = await import("playwright")

	const browser = await chromium.launch({
		args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
	})
	const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 })

	const errors: string[] = []
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
	page.on("pageerror", (e) => errors.push(String(e)))

	await page.goto(options.url, { waitUntil: "networkidle", timeout: 30_000 })
	// MapLibre composites tiles + the marker layer async after the network settles; give it a beat.
	await page.waitForTimeout(4_000)
	await page.screenshot({ path: options.outPNG })
	await browser.close()

	report?.(`[map-render] ${options.outPNG}; console errors=${errors.length}`)

	for (const e of errors.slice(0, 6)) {
		report?.("  " + e)
	}

	return { outPNG: options.outPNG, consoleErrors: errors }
}
