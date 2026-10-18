/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * This module configures the shared browser for Plotly and MapLibre rendering.
 * SwiftShader supplies WebGL without a hardware GPU.
 * Each caller owns navigation, readiness checks, and screenshots.
 * The browser package loads Playwright and stealth plugins when a session starts.
 */

import { withBrowserPage } from "@mailwoman/browser"
import type { Page } from "playwright"

/**
 * Options for {@linkcode withChromiumPage}.
 */
export interface ChromiumPageOptions {
	viewport: { width: number; height: number }
}

/**
 * Launch headless Chromium (SwiftShader WebGL), open one page at `deviceScaleFactor: 2`,
 * collect console + page errors, run `fn`, and dispose the browser.
 *
 * The callback owns navigation, waits and the screenshot.
 */
export async function withChromiumPage<T>(
	options: ChromiumPageOptions,
	fn: (page: Page) => Promise<T>
): Promise<{ result: T; consoleErrors: string[] }> {
	return withBrowserPage(
		{
			launchOptions: {
				args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
			},
			contextOptions: { viewport: options.viewport, deviceScaleFactor: 2 },
		},
		fn
	)
}
