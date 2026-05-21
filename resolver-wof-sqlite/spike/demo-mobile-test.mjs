/**
 * Mobile-viewport smoke for https://mailwoman.sister.software/demo/. Emulates iPhone 12 + a desktop
 * viewport, screenshots both, checks for layout overflow.
 */

import { chromium, devices } from "playwright"

const url = process.argv[2] ?? "https://mailwoman.sister.software/demo/"

const browser = await chromium.launch({ headless: true })

const cases = [
	{ name: "mobile", device: devices["iPhone 12"] },
	{ name: "desktop", viewport: { width: 1280, height: 800 } },
]

for (const c of cases) {
	const ctx = await browser.newContext(c.device ? c.device : { viewport: c.viewport })
	const page = await ctx.newPage()
	console.log(`\n=== ${c.name} ===`)
	await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 })
	await page.waitForFunction(
		() => {
			const btn = document.querySelector("button[type='submit']")
			return btn && !btn.disabled
		},
		{ timeout: 120_000 }
	)
	// Capture document overflow.
	const overflow = await page.evaluate(() => {
		const docW = document.documentElement.scrollWidth
		const viewW = document.documentElement.clientWidth
		return { docW, viewW, horizontalScroll: docW > viewW }
	})
	console.log(
		`document width ${overflow.docW}px / viewport ${overflow.viewW}px — horizontal scroll: ${overflow.horizontalScroll}`
	)
	const mapBox = await page.locator("section >> nth=1").boundingBox()
	const ctrlBox = await page.locator("section >> nth=0").boundingBox()
	console.log(`controls: ${JSON.stringify(ctrlBox)}`)
	console.log(`map: ${JSON.stringify(mapBox)}`)
	const screenshot = `/tmp/demo-${c.name}.png`
	await page.screenshot({ path: screenshot, fullPage: true })
	console.log(`screenshot → ${screenshot}`)
	await ctx.close()
}

await browser.close()
