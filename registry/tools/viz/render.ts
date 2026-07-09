/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a self-contained Plotly HTML to a PNG via headless Chromium — the shared renderer behind
 *   the `registry viz` figures (an internal helper, not a command).
 *
 *   Plotly 3D (`surface`/`scatter3d`) needs a real WebGL context; headless Chromium has none by
 *   default, so we force ANGLE's SwiftShader software rasterizer (`--use-gl=angle
 *   --use-angle=swiftshader --enable-unsafe-swiftshader`). 2D traces (`contour`/`heatmap`) render
 *   on the 2D canvas regardless. We wait for Plotly's `plotly_afterplot` to fire on every graph div
 *   rather than a fixed sleep, so the screenshot can't race the (async) WebGL paint.
 *
 *   Playwright (headless Chromium) is a heavy dev-only dependency — lazy-imported inside the entry
 *   fn (the corpus-tools lazy-import convention), so importing `@mailwoman/registry/tools` never
 *   pays for it.
 */

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

/** Options for {@linkcode renderPlotlyHTMLToPNG}. */
export interface RenderPlotlyOptions {
	/** The self-contained Plotly HTML file. */
	inHTML: string
	/** Output PNG path. */
	outPNG: string
	/** Viewport width. Default 1160. */
	width?: number
	/** Viewport height. Default 1000. */
	height?: number
}

/** Screenshot a Plotly HTML page after every graph div's `plotly_afterplot` fires. */
export async function renderPlotlyHTMLToPNG(
	options: RenderPlotlyOptions,
	report?: (line: string) => void
): Promise<{ outPNG: string; consoleErrors: string[] }> {
	// playwright + Chromium are heavy — lazy import (the pipeline convention).
	const { chromium } = await import("playwright")

	const browser = await chromium.launch({
		args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
	})
	const page = await browser.newPage({
		viewport: { width: options.width ?? 1160, height: options.height ?? 1000 },
		deviceScaleFactor: 2,
	})

	const errors: string[] = []
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
	page.on("pageerror", (e) => errors.push(String(e)))

	await page.goto(pathToFileURL(resolve(options.inHTML)).href, { waitUntil: "networkidle" })

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

	await page.screenshot({ path: resolve(options.outPNG), fullPage: true })
	await browser.close()

	if (errors.length) {
		report?.(`[render] ${errors.length} console error(s):`)

		for (const e of errors.slice(0, 8)) {
			report?.("  " + e)
		}
	}
	report?.(`[render] ${options.outPNG}`)

	return { outPNG: options.outPNG, consoleErrors: errors }
}
