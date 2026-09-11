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
 *   - MapLibre needs a real WebGL context — the shared harness (`./browser.ts`) provides one through
 *       SwiftShader.
 *   - The basemap tiles come from `tiles.mailwoman.ai`, which CORS-restricts to localhost + the docs
 *       domains — so the page MUST be SERVED OVER LOCALHOST, not opened as a file (a file:// page
 *       renders accurate markers on a blank basemap). Serve the output dir first, e.g. `python3 -m
 *       http.server 8899 -d <dir>`, then point this at `http://localhost:8899/<page>.html`.
 *
 *   The map paints asynchronously after the network settles; we wait for networkidle, then a fixed
 *   beat for the basemap tiles + marker layer to finish compositing.
 */

import { withChromiumPage } from "#tools/viz/browser"

/**
 * Options for {@linkcode renderServedMapToPNG}.
 */
export interface RenderMapOptions {
	/**
	 * The served localhost URL of the map page (NOT a file:// path — see the module doc).
	 */
	url: string
	/**
	 * Output PNG path.
	 */
	outPNG: string
}

/**
 * Screenshot a served MapLibre map page once the tiles + marker layer settle.
 */
export async function renderServedMapToPNG(
	options: RenderMapOptions,
	report?: (line: string) => void
): Promise<{ outPNG: string; consoleErrors: string[] }> {
	const { consoleErrors: errors } = await withChromiumPage({ viewport: { width: 1100, height: 760 } }, async (page) => {
		await page.goto(options.url, { waitUntil: "networkidle", timeout: 30_000 })
		// MapLibre composites tiles + the marker layer async after the network settles; give it a beat.
		await page.waitForTimeout(4000)
		await page.screenshot({ path: options.outPNG })
	})

	report?.(`[map-render] ${options.outPNG}; console errors=${errors.length}`)

	for (const e of errors.slice(0, 6)) {
		report?.("  " + e)
	}

	return { outPNG: options.outPNG, consoleErrors: errors }
}
