// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Renders Earth's square PNG icons from `public/icon.svg` in headless Chromium.
 *
 *   - `apple-touch-icon.png` is 180 pixels square. iOS shows it on the Home Screen
 *     and rounds the corners itself, so the artwork fills the square on the theme color.
 *   - `icon-maskable-512.png` is 512 pixels square, with the artwork inside the central 80%.
 *     Android crops a maskable icon to its own shape, and the W3C safe zone is
 *     the central circle of 80% diameter.
 *
 *   Usage: node packages/earth/tools/render-icons.run.ts
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { chromium } from "@playwright/test"

/**
 * Earth's theme color, the background a square icon fills its corners with.
 */
const BACKGROUND = "#0b1020"

/**
 * The margin around the artwork in a maskable icon, as a share of the side.
 *
 * A 10% margin on each side keeps the artwork inside the 80% safe zone.
 */
const MASKABLE_MARGIN = 0.1

interface IconSpec {
	file: string
	size: number
	margin: number
}

const ICONS: IconSpec[] = [
	{ file: "apple-touch-icon.png", size: 180, margin: 0 },
	{ file: "icon-maskable-512.png", size: 512, margin: MASKABLE_MARGIN },
]

const svg = await readLocalTextFile(resolvePackagePath("@mailwoman/earth", "public", "icon.svg"))
const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
const browser = await chromium.launch()

try {
	for (const { file, size, margin } of ICONS) {
		const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
		const inset = Math.round(size * margin)

		await page.setContent(
			`<html><body style="margin:0;background:${BACKGROUND}">` +
				`<img src="${source}" style="position:absolute;left:${inset}px;top:${inset}px;` +
				`width:${size - 2 * inset}px;height:${size - 2 * inset}px"></body></html>`
		)

		// The tools project has no DOM library, so the wait for the decoded image is a page expression.
		await page.waitForFunction("document.images[0]?.complete && document.images[0].naturalWidth > 0")

		const png = await page.screenshot({ type: "png", omitBackground: false })

		await writeLocalBuffer(png, resolvePackagePath("@mailwoman/earth", "public", file))
		await page.close()

		console.log(`${file}: ${size}×${size}, artwork inset ${inset}px`)
	}
} finally {
	await browser.close()
}
