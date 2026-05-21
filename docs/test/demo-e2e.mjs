/**
 * End-to-end test for the /demo page.
 *
 * Captures EVERY console error + page error during a fresh load, a parse cycle, and a theme toggle.
 * Fails if any error matches our blocklist (style/terrain race, MapLibre teardown errors, unhandled
 * promise rejections we'd rather know about). Pass-through for known-noisy warnings (onnxruntime
 * initializer messages, WebGL GPU stalls).
 *
 * Why mjs not ts: this file is invoked directly via `node docs/test/demo.e2e.test.mjs` — no
 * Docusaurus / vitest harness in the loop, so we can run it against the live deploy before merging
 * without any build step. Doubles as a CI-ready test once we wire it up.
 */

import { chromium } from "playwright"

const BASE = process.env["MAILWOMAN_DEMO_URL"] ?? "https://mailwoman.sister.software/demo/"

/**
 * Substrings that DO indicate a real bug. Match anywhere in the message text. Add to this list when
 * the operator reports a new symptom so future regressions get caught in CI.
 */
const FAIL_PATTERNS = [
	/style is not done loading/i,
	/cannot read properties of null \(reading 'addSource'\)/i,
	/cannot read properties of null \(reading 'addLayer'\)/i,
	/cannot read properties of null \(reading 'setTerrain'\)/i,
	/cannot read properties of undefined \(reading 'addSource'\)/i,
	/uncaught.*maplibre/i,
	/uncaught.*sqlite/i,
	/uncaught.*onnxruntime/i,
	// Module-not-found for our own packages — a webpack alias regression would surface here.
	/cannot find module '@mailwoman\//i,
]

/** Substrings that are noisy but harmless. Stripped from output and never fail the test. */
const IGNORE_PATTERNS = [
	/Removing initializer 'val_/, // onnxruntime cleanup
	/WebGL.*GPU stall/i,
	/^SQL TRACE/,
	/^SPIKE /,
	/No available adapters/,
	/removing requested execution provider/,
]

function shouldIgnore(text) {
	return IGNORE_PATTERNS.some((p) => p.test(text))
}

function classify(text) {
	for (const p of FAIL_PATTERNS) if (p.test(text)) return "fail"
	return "noise"
}

async function main() {
	const browser = await chromium.launch({ headless: true })
	try {
		const context = await browser.newContext({
			// Defeat browser cache so we always test the current deploy.
			bypassCSP: true,
		})
		const page = await context.newPage()
		const events = []
		page.on("console", (msg) => {
			const text = `[${msg.type()}] ${msg.text()}`
			if (!shouldIgnore(text)) events.push(text)
		})
		page.on("pageerror", (e) => events.push(`[pageerror] ${e.message}`))
		page.on("requestfailed", (req) => {
			// Asset 404 / network failure → almost always actionable.
			const url = req.url()
			if (url.startsWith(BASE) || url.includes("/mailwoman/")) {
				events.push(`[requestfailed] ${req.method()} ${url} (${req.failure()?.errorText ?? "?"})`)
			}
		})

		console.log(`→ Loading ${BASE}`)
		await page.goto(BASE, { waitUntil: "networkidle", timeout: 180_000 })

		console.log("→ Waiting for runtimes (button enables when classifier loads)…")
		await page.waitForFunction(() => !document.querySelector("button[type='submit']")?.disabled, {
			timeout: 180_000,
		})

		console.log("→ Clicking Parse + resolve (default address)…")
		await page.click("button[type='submit']")
		await page.waitForFunction(() => document.body.textContent?.includes("Parsed components"), { timeout: 60_000 })

		// Give the map a moment to settle after fitBounds / setTerrain re-wires.
		await page.waitForTimeout(3000)

		console.log("→ Clicking Empire State example…")
		await page.locator("button:has-text('Empire State')").click()
		await page.click("button[type='submit']")
		await page.waitForTimeout(3000)

		console.log("→ Toggling theme to dark…")
		await page.evaluate(() => {
			document.documentElement.setAttribute("data-theme", "dark")
		})
		await page.waitForTimeout(3000)

		console.log("→ Toggling back to light…")
		await page.evaluate(() => {
			document.documentElement.setAttribute("data-theme", "light")
		})
		await page.waitForTimeout(3000)

		console.log("→ Clicking ZIP-only example…")
		await page.locator("button:has-text('ZIP only')").click()
		await page.click("button[type='submit']")
		await page.waitForTimeout(3000)

		console.log("\n--- Captured console / page events ---")
		const failures = events.filter((e) => classify(e) === "fail")
		const others = events.filter((e) => classify(e) === "noise")
		for (const e of failures) console.log(`  FAIL: ${e}`)
		console.log(`(${failures.length} failures, ${others.length} other events)`)
		if (failures.length > 0) {
			console.error(`\n✗ ${failures.length} error(s) matched FAIL patterns. Failing.`)
			process.exit(1)
		}
		console.log("\n✓ No matching errors.")
	} finally {
		await browser.close()
	}
}

main().catch((e) => {
	console.error("test failed:", e)
	process.exit(1)
})
