/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a {@link toMapHTML} page (MapLibre GL + Protomaps basemap) to a PNG via headless Chromium.
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
 *   Run: node registry/tools/viz/render-map.ts <served-url> <out.png>
 */

import { chromium } from "playwright"

const url = process.argv[2]
const out = process.argv[3]

if (!url || !out) {
	console.error("usage: render-map.ts <served-localhost-url> <out.png>")
	process.exit(1)
}

const browser = await chromium.launch({
	args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
})
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 })

const errors: string[] = []
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
page.on("pageerror", (e) => errors.push(String(e)))

await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 })
// MapLibre composites tiles + the marker layer async after the network settles; give it a beat.
await page.waitForTimeout(4_000)
await page.screenshot({ path: out })
await browser.close()

console.error(`[map-render] ${out}; console errors=${errors.length}`)

for (const e of errors.slice(0, 6)) {
	console.error("  " + e)
}
