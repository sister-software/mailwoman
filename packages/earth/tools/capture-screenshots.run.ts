// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Captures two install-prompt screenshots for the web app manifest, a narrow one
 *   and a wide one, from a served build of Earth with the canned runtime.
 *
 *   Check both images before listing them under the manifest's `screenshots`:
 *   a capture without the basemap tiles shows a blank map.
 *
 *   The images are JPEG.
 *   The service worker's precache takes PNG files, so it leaves the screenshots out.
 *
 *   Start the preview server
 *   first (`yarn workspace @mailwoman/earth build && yarn workspace @mailwoman/earth preview`).
 *
 *   Usage: node packages/earth/tools/capture-screenshots.run.ts [--url http://localhost:7771/]
 */

import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { chromium } from "@playwright/test"

const { values } = parseArguments({
	options: {
		url: { type: "string", default: "http://localhost:7771/" },
		// An HTTP proxy for the tile and data hosts, such as a sandbox's egress proxy.
		proxy: { type: "string" },
	},
})

/**
 * The address each screenshot shows parsed, one the canned runtime answers.
 */
const QUERY = "350 5th Ave, New York, NY 10118"

/**
 * How long the map gets to draw its tiles after the parse, in milliseconds.
 */
const SETTLE_MS = 10_000

interface ShotSpec {
	file: string
	width: number
	height: number
	scale: number
}

// The narrow shot is a 390-pixel phone at twice the density, 780×1688, as the manifest declares.
const SHOTS: ShotSpec[] = [
	{ file: "narrow.jpg", width: 390, height: 844, scale: 2 },
	{ file: "wide.jpg", width: 1280, height: 800, scale: 1 },
]

const browser = await chromium.launch(
	values.proxy ? { proxy: { server: values.proxy, bypass: "localhost,127.0.0.1" } } : {}
)

try {
	for (const { file, width, height, scale } of SHOTS) {
		const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
		const url = new URL(values.url)

		url.searchParams.set("runtime", "fake")
		url.searchParams.set("q", QUERY)

		await page.goto(url.href, { waitUntil: "load" })
		await page.locator("input").first().press("Enter")
		await page.waitForTimeout(SETTLE_MS)

		const jpeg = await page.screenshot({ type: "jpeg", quality: 80 })

		await writeLocalBuffer(jpeg, resolvePackagePath("@mailwoman/earth", "public", "screenshots", file))
		await page.close()

		console.log(`${file}: ${width * scale}×${height * scale}, ${jpeg.byteLength} bytes`)
	}
} finally {
	await browser.close()
}
