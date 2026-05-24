import { chromium } from "playwright"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()

const consoleLines = []
page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`))
page.on("pageerror", (e) => consoleLines.push(`PAGEERROR: ${e.message}`))

console.log("→ Loading https://mailwoman.sister.software/demo/ …")
await page.goto("https://mailwoman.sister.software/demo/", { waitUntil: "networkidle", timeout: 120_000 })
console.log("→ Hydrated. Waiting up to 90s for `Parse + resolve` button to enable …")

try {
	await page.waitForFunction(
		() => {
			const btn = document.querySelector("button[type='submit']")
			return btn && !btn.disabled
		},
		{ timeout: 90_000 }
	)
	console.log("✓ Button enabled — assets loaded successfully")
} catch (e) {
	console.error("✗ Button never enabled:", e.message)
	const text = await page.textContent("body")
	console.error("Page body snippet:", text?.slice(0, 500))
}

console.log("\n--- Console logs ---")
for (const line of consoleLines) console.log(line)

await browser.close()
