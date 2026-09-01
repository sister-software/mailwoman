/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared headless-Chromium harness behind the `registry viz` renderers (an internal helper,
 *   not a command). The WebGL consumers (Plotly 3D, MapLibre) get no GPU in headless Chromium, so
 *   the browser launches on ANGLE's SwiftShader software rasterizer (`--use-gl=angle
 *   --use-angle=swiftshader --enable-unsafe-swiftshader`); each caller owns its own navigation +
 *   wait strategy and screenshots inside the callback.
 *
 *   Playwright (headless Chromium) is a heavy dev-only dependency — lazy-imported at call time (the
 *   corpus-tools lazy-import convention), so importing `@mailwoman/registry/tools` never pays for
 *   it.
 */

import type { Page } from "playwright"

/**
 * Options for {@linkcode withChromiumPage}.
 */
export interface ChromiumPageOptions {
	viewport: { width: number; height: number }
}

/**
 * Launch headless Chromium (SwiftShader WebGL), open one page at `deviceScaleFactor: 2`, collect console + page errors,
 * run `fn`, and dispose the browser. The callback owns navigation, waits, and the screenshot.
 */
export async function withChromiumPage<T>(
	options: ChromiumPageOptions,
	fn: (page: Page) => Promise<T>
): Promise<{ result: T; consoleErrors: string[] }> {
	const { chromium } = await import("playwright")

	const browser = await chromium.launch({
		args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
	})

	const page = await browser.newPage({ viewport: options.viewport, deviceScaleFactor: 2 })

	const errors: string[] = []
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
	page.on("pageerror", (e) => errors.push(String(e)))

	const result = await fn(page)
	await browser[Symbol.asyncDispose]()

	return { result, consoleErrors: errors }
}
