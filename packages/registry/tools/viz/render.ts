/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a self-contained Plotly HTML to a PNG via headless Chromium — the shared renderer behind
 *   the `registry viz` figures (an internal helper, not a command).
 *
 *   Plotly 3D (`surface`/`scatter3d`) needs a real WebGL context, which the shared harness
 *   (`./browser.ts`) provides through SwiftShader; 2D traces (`contour`/`heatmap`) render on the 2D
 *   canvas regardless. We wait for Plotly's `plotly_afterplot` to fire on every graph div rather
 *   than a fixed sleep, so the screenshot can't race the (async) WebGL paint.
 */

import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { resolvePath as resolve } from "path-ts"

import { withChromiumPage } from "#tools/viz/browser"

/**
 * Options for {@linkcode renderPlotlyHTMLToPNG}.
 */
export interface RenderPlotlyOptions {
	/**
	 * The self-contained Plotly HTML file.
	 */
	inHTML: string
	/**
	 * Output PNG path.
	 */
	outPNG: string
	/**
	 * Viewport width. Default 1160.
	 */
	width?: number
	/**
	 * Viewport height. Default 1000.
	 */
	height?: number
}

/**
 * Screenshot a Plotly HTML page after every graph div's `plotly_afterplot` fires.
 */
export async function renderPlotlyHTMLToPNG(
	options: RenderPlotlyOptions,
	report?: (line: string) => void
): Promise<{ outPNG: string; consoleErrors: string[] }> {
	const { consoleErrors: errors } = await withChromiumPage(
		{ viewport: { width: options.width ?? 1160, height: options.height ?? 1000 } },
		async (page) => {
			await page.goto(pathToFileURL(resolve(options.inHTML)).href, { waitUntil: "networkidle" })

			// Resolve once every Plotly graph div has fired plotly_afterplot (3D paints land async, after
			// newPlot's promise resolves), with a per-div fallback so an already-painted div can't hang us.
			await page.evaluate(async () => {
				// Runs in the BROWSER — reach DOM/Plotly globals via globalThis so the script needs no DOM lib.
				interface PlotlyDiv {
					_fullLayout?: unknown
					on?: (event: string, cb: () => void) => void
				}

				const doc = Reflect.get(globalThis, "document") as { querySelectorAll(s: string): Iterable<unknown> }

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
		}
	)

	if (errors.length) {
		report?.(`[render] ${errors.length} console error(s):`)

		for (const e of errors.slice(0, 8)) {
			report?.("  " + e)
		}
	}

	report?.(`[render] ${options.outPNG}`)

	return { outPNG: options.outPNG, consoleErrors: errors }
}
