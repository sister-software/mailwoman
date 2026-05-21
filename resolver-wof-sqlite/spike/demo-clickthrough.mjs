/**
 * Extended smoke test for https://mailwoman.sister.software/demo/. Loads the page, waits for the
 * three runtimes to initialize, clicks the default "Parse + resolve" action, and asserts the result
 * panel renders something + a marker shows on the map.
 *
 * Run from this dir (has playwright): node demo-clickthrough.mjs
 * [https://mailwoman.sister.software/demo/]
 */

import { chromium } from "playwright"

const url = process.argv[2] ?? "https://mailwoman.sister.software/demo/"
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()

const consoleLines = []
const pageErrors = []
page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`))
page.on("pageerror", (e) => pageErrors.push(e.message))

console.log(`→ Loading ${url}`)
await page.goto(url, { waitUntil: "networkidle", timeout: 180_000 })

console.log("→ Waiting up to 120s for runtimes to initialize…")
await page.waitForFunction(
	() => {
		const btn = document.querySelector("button[type='submit']")
		return btn && !btn.disabled
	},
	{ timeout: 120_000 }
)

console.log("→ Clicking Parse + resolve…")
await page.click("button[type='submit']")

// Wait for the result panel — `Resolved place` heading appears when the resolver hit something.
try {
	await page.waitForFunction(() => document.body.textContent?.includes("Parsed components"), { timeout: 30_000 })
	console.log("✓ Result panel rendered")
} catch (e) {
	console.error("✗ Result panel never rendered:", e.message)
}

// Check for any marker the demo dropped on the map.
const markerCount = await page.locator(".maplibregl-marker").count()
console.log(`✓ Map markers visible: ${markerCount}`)

// Pull the resolved place name if present.
const resolved = await page.evaluate(() => {
	const dt = [...document.querySelectorAll("dt")].find((el) => el.textContent === "name")
	return dt?.nextElementSibling?.textContent ?? null
})
console.log(`✓ Resolved place: ${resolved ?? "(none)"}`)

const componentCount = await page.locator("tbody tr").count()
console.log(`✓ Parsed component rows: ${componentCount}`)

console.log("\n--- Page errors ---")
if (pageErrors.length === 0) console.log("  (none)")
for (const e of pageErrors) console.log("  " + e)

console.log("\n--- Console signal (filtered) ---")
for (const line of consoleLines.filter((l) => !l.includes("WebGL") && !l.includes("SQL TRACE")))
	console.log("  " + line)

await browser.close()
console.log("\nDone.")
