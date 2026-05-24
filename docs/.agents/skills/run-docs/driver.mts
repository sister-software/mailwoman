#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Headless driver for the @mailwoman/docs Docusaurus site.
 *
 *   Assumes a dev server is already listening (default http://localhost:7770) — start it with `yarn
 *   start` (foreground) or `yarn start &` (background) from docs/ first. The driver does NOT launch
 *   the server itself; that's a separate long-lived process and conflating the two makes failure
 *   modes harder to read.
 *
 *   Usage: node .claude/skills/run-docs/driver.mjs screenshot <path> [out.png] node
 *   .claude/skills/run-docs/driver.mjs check <path> # 200 + no console errors node
 *   .claude/skills/run-docs/driver.mjs smoke # all key routes node
 *   .claude/skills/run-docs/driver.mjs eval <path> "<js>" # run in page, print return value
 *
 *   Env: MAILWOMAN_DOCS_URL base URL (default http://localhost:7770)
 */

import { chromium, type Page } from "@playwright/test"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"

const BASE = process.env.MAILWOMAN_DOCS_URL ?? "http://localhost:7770"
const SCREENSHOT_DIR = "/tmp/mailwoman-docs"

type PageCallback<T> = (page: Page, consoleErrors: string[]) => Promise<T>

async function withPage<T>(fn: PageCallback<T>): Promise<T> {
	const browser = await chromium.launch()
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
	const page = await ctx.newPage()
	const consoleErrors: string[] = []

	page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`))
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`)
	})

	try {
		return await fn(page, consoleErrors)
	} finally {
		await browser.close()
	}
}

function url(path: string | URL) {
	return new URL(path, BASE).toString()
}

async function cmdScreenshot(path: string, outArg?: string) {
	const out = resolve(outArg ?? `${SCREENSHOT_DIR}/${path.replace(/[/]+/g, "_") || "root"}.png`)
	await mkdir(dirname(out), { recursive: true })
	const result = await withPage(async (page) => {
		const resp = await page.goto(url(path), { waitUntil: "networkidle", timeout: 60_000 })
		await page.screenshot({ path: out, fullPage: true })
		return { status: resp?.status() ?? 0, title: await page.title() }
	})
	console.log(`screenshot ${path} → ${out} (HTTP ${result.status}, "${result.title}")`)
}

async function checkRoute(path: string) {
	return await withPage(async (page: Page, consoleErrors: string[]) => {
		const resp = await page.goto(url(path), { waitUntil: "networkidle", timeout: 60_000 })
		// Docusaurus serves its 404 with HTTP 200, so detect the soft-404 by reading the rendered <h1>.
		const heading = await page
			.locator("h1")
			.first()
			.textContent()
			.catch(() => null)
		const soft404 = (heading ?? "").trim() === "Page Not Found"
		return {
			status: resp?.status() ?? 0,
			title: await page.title(),
			heading,
			soft404,
			errors: consoleErrors,
		}
	})
}

interface RouteResult {
	status: number
	title: string
	soft404: boolean
	errors: string[]
}

function reportRoute(path: string, result: RouteResult) {
	const flags = [`HTTP ${result.status}`, `title="${result.title}"`, `console errors=${result.errors.length}`]
	if (result.soft404) flags.push("SOFT-404")
	console.log(`check ${path}: ${flags.join(", ")}`)
	for (const e of result.errors) console.log(`  ${e.split("\n")[0]}`)
}

async function cmdCheck(path: string) {
	const result = await checkRoute(path)
	reportRoute(path, result)
	if (result.status >= 400 || result.errors.length || result.soft404) process.exit(1)
}

async function cmdSmoke() {
	// Real routes, not just "/docs/" — Docusaurus's bare /docs/ is a soft-404; the actual entry is /docs/understanding/.
	const routes = ["/", "/demo/", "/blog/", "/docs/understanding/", "/docs/plan/"]
	let fail = 0

	for (const r of routes) {
		try {
			const result = await checkRoute(r)
			reportRoute(r, result)
			if (result.status >= 400 || result.errors.length || result.soft404) fail++
		} catch (e) {
			fail++
			if (e instanceof Error) {
				console.log(`check ${r}: THREW ${e.message.split("\n")[0]}`)
			} else {
				console.log(`check ${r}: THREW ${String(e).split("\n")[0]}`)
			}
		}
	}

	if (fail) process.exit(1)
}

async function cmdEval(path: string, js: string) {
	const result = await withPage(async (page) => {
		await page.goto(url(path), { waitUntil: "networkidle", timeout: 60_000 })
		return await page.evaluate(`(async () => { ${js} })()`)
	})
	console.log(JSON.stringify(result, null, 2))
}

const { values, positionals } = parseArgs({
	options: {
		screenshot: { type: "string", short: "s" },

		check: { type: "string", short: "c" },
		eval: { type: "string", short: "e", multiple: true },
		smoke: { type: "boolean" },
		out: { type: "string", short: "o" },
	},
	allowPositionals: true,
})

if (values.smoke) {
	await cmdSmoke()
} else if (values.screenshot) {
	await cmdScreenshot(values.screenshot, values.out)
} else if (values.check) {
	await cmdCheck(values.check)
} else if (values.eval) {
	const [path, ...jsParts] = positionals
	if (!path || !jsParts.length) {
		console.error(`eval requires a path and JS code\nsee header of ${import.meta.url} for usage`)
		process.exit(2)
	}
	const js = jsParts.join(" ")
	await cmdEval(path, js)
} else {
	console.error(`no command provided\nsee header of ${import.meta.url} for usage`)
	process.exit(2)
}
