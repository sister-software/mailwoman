/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a self-contained Plotly HTML to a PNG via headless Chromium.
 *
 *   Plotly 3D (`surface`/`scatter3d`) needs a real WebGL context; headless Chromium has none by
 *   default, so we force ANGLE's SwiftShader software rasterizer (`--use-gl=angle
 *   --use-angle=swiftshader --enable-unsafe-swiftshader`). 2D traces (`contour`/`heatmap`) render
 *   on the 2D canvas regardless. We wait for Plotly's `plotly_afterplot` to fire on every graph div
 *   rather than a fixed sleep, so the screenshot can't race the (async) WebGL paint.
 *
 *   Run: node registry/tools/viz/render.ts <in.html> <out.png> [width] [height]
 */

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { chromium } from "playwright"

const { positionals } = parseArgs({ allowPositionals: true, strict: false })
const [inHTML, outPNG, w = "1160", h = "1000"] = positionals

if (!inHTML || !outPNG) {
	console.error("usage: render.ts <in.html> <out.png> [width] [height]")
	process.exit(1)
}

const browser = await chromium.launch({
	args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
})
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 })

const errors: string[] = []
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
page.on("pageerror", (e) => errors.push(String(e)))

await page.goto(pathToFileURL(resolve(inHTML)).href, { waitUntil: "networkidle" })

// Resolve once every Plotly graph div has fired plotly_afterplot (3D paints land async, after
// newPlot's promise resolves), with a per-div fallback so an already-painted div can't hang us.
await page.evaluate(async () => {
	// Runs in the BROWSER — reach DOM/Plotly globals via globalThis so the script needs no DOM lib.
	interface PlotlyDiv {
		_fullLayout?: unknown
		on?: (event: string, cb: () => void) => void
	}
	const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<unknown> } }).document
	const divs = [...doc.querySelectorAll("div")]
		.map((d) => d as PlotlyDiv)
		.filter((d) => d._fullLayout && typeof d.on === "function")
	await Promise.all(
		divs.map(
			(d) =>
				new Promise<void>((res) => {
					d.on!("plotly_afterplot", () => res())
					setTimeout(() => res(), 2000)
				})
		)
	)
})
// Final settle for the software WebGL rasterizer.
await page.waitForTimeout(800)

await page.screenshot({ path: resolve(outPNG), fullPage: true })
await browser.close()

if (errors.length) {
	console.error(`[render] ${errors.length} console error(s):`)

	for (const e of errors.slice(0, 8)) {
		console.error("  " + e)
	}
}
console.error(`[render] ${outPNG}`)
