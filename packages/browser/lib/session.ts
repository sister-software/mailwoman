/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions, Page } from "playwright"

/**
 * These options configure a browser used for acquisition, rendering, or agent interaction.
 */
export interface BrowserSessionOptions {
	launchOptions?: LaunchOptions
	contextOptions?: BrowserContextOptions
	/**
	 * Connect to an existing Chromium instance instead of launching one.
	 * Each session still creates its own context.
	 */
	cdpEndpoint?: string
}

/**
 * A session owns its browser connection and its isolated context.
 */
export interface BrowserSession extends AsyncDisposable {
	browser: Browser
	context: BrowserContext
}

/**
 * Creates a Chromium context with stealth enabled before callers open pages.
 *
 * Every call uses a separate plugin instance.
 * Our own E2E suites use standard Playwright directly.
 */
export async function createBrowserSession(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
	const [{ chromium }, { addExtra }, { default: StealthPlugin }] = await Promise.all([
		import("playwright"),
		import("playwright-extra"),
		import("puppeteer-extra-plugin-stealth"),
	])

	const launcher = addExtra(chromium)
	launcher.use(StealthPlugin())

	const browser = options.cdpEndpoint
		? await launcher.connectOverCDP(options.cdpEndpoint)
		: await launcher.launch({ headless: true, ...options.launchOptions })

	try {
		const context = await browser.newContext({ acceptDownloads: true, ...options.contextOptions })
		let disposed = false

		return {
			browser,
			context,
			async [Symbol.asyncDispose]() {
				if (disposed) return
				disposed = true

				try {
					await context.close()
				} finally {
					await browser.close()
				}
			},
		}
	} catch (error) {
		await browser.close()
		throw error
	}
}

/**
 * Runs a callback with one page and closes the session after the callback settles.
 */
export async function withBrowserPage<T>(
	options: BrowserSessionOptions,
	fn: (page: Page, consoleErrors: string[]) => Promise<T>
): Promise<{ result: T; consoleErrors: string[] }> {
	await using session = await createBrowserSession(options)
	const page = await session.context.newPage()
	const consoleErrors: string[] = []

	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text())
		}
	})

	page.on("pageerror", (error) => consoleErrors.push(String(error)))

	return { result: await fn(page, consoleErrors), consoleErrors }
}
