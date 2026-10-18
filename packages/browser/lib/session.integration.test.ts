/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { chromium, type Browser } from "playwright"
import { expect, it } from "vitest"

import { createBrowserSession, withBrowserPage } from "#session"

import { serveBrowserFixture } from "../test/site.ts"

it("applies stealth before scripts in every page and frame while standard Playwright reports automation", async () => {
	await using site = await serveBrowserFixture()
	await using baseline = await chromium.launch()
	const baselinePage = await baseline.newPage()
	await baselinePage.goto(site.url)
	expect(await baselinePage.evaluate("globalThis.initialWebdriver")).toBe(true)

	await using session = await createBrowserSession()

	for (const index of [0, 1]) {
		const page = await session.context.newPage()
		const response = await page.goto(`${site.url}?page=${index}`)
		expect(await page.evaluate("globalThis.initialWebdriver")).toBe(false)
		const userAgent = await page.evaluate<string>("navigator.userAgent")
		expect(userAgent).not.toContain("HeadlessChrome")
		expect(response?.request().headers()["user-agent"]).toBe(userAgent)
	}

	const framedPage = await session.context.newPage()
	await framedPage.goto(site.url)
	const frame = framedPage.frames().find((entry) => entry.url().endsWith("/frame"))
	expect(frame).toBeTruthy()
	expect(await frame!.evaluate("globalThis.initialWebdriver")).toBe(false)

	await using standardAfterSession = await chromium.launch()
	const standardPage = await standardAfterSession.newPage()
	await standardPage.goto(site.url)
	expect(await standardPage.evaluate("globalThis.initialWebdriver")).toBe(true)
})

it("awaits callbacks, captures console errors, and closes the browser after success", async () => {
	await using site = await serveBrowserFixture()
	let browser: Browser | null = null

	const result = await withBrowserPage({}, async (page) => {
		browser = page.context().browser()
		await page.goto(site.url)
		await page.evaluate('console.error("fixture error")')

		return page.title()
	})

	expect(result).toEqual({ result: "Browser fixture", consoleErrors: ["fixture error"] })
	expect(browser!.isConnected()).toBe(false)
})

it("closes the browser when a callback rejects", async () => {
	await using site = await serveBrowserFixture()
	let browser: Browser | null = null

	await expect(
		withBrowserPage({}, async (page) => {
			browser = page.context().browser()
			await page.goto(site.url)
			throw new Error("fixture rejection")
		})
	).rejects.toThrow("fixture rejection")

	expect(browser!.isConnected()).toBe(false)
})

it("saves a browser download and produces a PNG screenshot", async () => {
	await using site = await serveBrowserFixture()
	await using scratch = await temporaryDirectory("browser-download-")

	await withBrowserPage({}, async (page) => {
		await page.goto(site.url)
		const image = await page.screenshot()
		expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")

		const [download] = await Promise.all([
			page.waitForEvent("download"),
			page.getByRole("link", { name: "Download addresses" }).click(),
		])

		const destination = scratch.path(download.suggestedFilename())
		await download.saveAs(destination.toString())
		expect(await readLocalTextFile(destination)).toBe("address\n10 Downing Street, London SW1A 2AA\n")
	})
})
