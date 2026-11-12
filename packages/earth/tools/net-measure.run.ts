// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Measures Earth's network traffic over a scripted camera sequence.
 *
 *   The tool loads the page in headless Chromium, records every off-origin request through
 *   the Chrome DevTools Protocol, and prints request counts, bytes, cancellations,
 *   cache status, protocol and latency percentiles per phase and per host.
 *   The run aborts with exit code 2 when the transferred bytes pass `--budget-mb`.
 *
 *   The sequence has three phases: the initial load, three flights that each finish loading
 *   (London, Paris, New York), and five flights that each interrupt the previous one
 *   after 600 ms (Tokyo, Sydney, Rio de Janeiro, Moscow, Cape Town).
 *
 *   Start the preview server
 *   first (`yarn workspace @mailwoman/earth build && yarn workspace @mailwoman/earth preview`).
 *
 *   Usage: node packages/earth/tools/net-measure.run.ts
 *   [--url http://localhost:7771/?no-model] [--budget-mb 40]
 */

import { integerArgument, parseArguments } from "@mailwoman/core/scripting/arguments"
import { percentile } from "@mailwoman/core/stats"
import { chromium } from "@playwright/test"

const { values } = parseArguments({
	options: {
		url: { type: "string", default: "http://localhost:7771/?no-model" },
		"budget-mb": { type: "string", default: "40" },
	},
})

const byteBudget = integerArgument("budget-mb", values["budget-mb"]) * 1024 * 1024
const pageOrigin = new URL(values.url).host

interface RequestRecord {
	url: string
	host: string
	phase: string
	start: number
	end?: number
	status?: number
	protocol?: string
	cacheStatus?: string
	fromCache?: boolean
	bytes: number
	canceled?: boolean
	failed?: string
	connectionID?: number
}

const records = new Map<string, RequestRecord>()
let phase = "boot"
let totalBytes = 0

function tally<K>(rows: readonly RequestRecord[], key: (row: RequestRecord) => K): [K, number][] {
	const counts = new Map<K, number>()

	for (const row of rows) {
		counts.set(key(row), (counts.get(key(row)) ?? 0) + 1)
	}

	return [...counts]
}

function formatTally(rows: readonly RequestRecord[], key: (row: RequestRecord) => string | number): string {
	return tally(rows, key)
		.map(([value, count]) => `${value}:${count}`)
		.join(",")
}

function formatMilliseconds(value: number | null): string {
	return value == null ? "-" : `${value.toFixed(0)}ms`
}

function summarize(label: string, rows: RequestRecord[]): void {
	const byHost = Map.groupBy(rows, (row) => row.host)

	console.log(`\n== ${label}: ${rows.length} requests`)

	for (const [host, hostRows] of [...byHost].toSorted((a, b) => b[1].length - a[1].length)) {
		const done = hostRows.filter((row) => row.end != null && !row.canceled && !row.failed)
		const canceled = hostRows.filter((row) => row.canceled).length
		const failed = hostRows.filter((row) => row.failed && !row.canceled).length
		const bytes = hostRows.reduce((sum, row) => sum + row.bytes, 0)
		const latencies = done.map((row) => row.end! - row.start)
		const connections = new Set(hostRows.map((row) => row.connectionID).filter((id) => id != null)).size

		console.log(
			`  ${host.padEnd(44)} n=${hostRows.length} done=${done.length} canceled=${canceled} failed=${failed} ` +
				`bytes=${(bytes / 1024).toFixed(0)}KB p50=${formatMilliseconds(percentile(latencies, 50))} ` +
				`p95=${formatMilliseconds(percentile(latencies, 95))} conns=${connections} ` +
				`status=${formatTally(done, (row) => row.status ?? 0)} ` +
				`cache=${formatTally(done, (row) => row.cacheStatus ?? (row.fromCache ? "browser-cache" : "-"))} ` +
				`proto=${formatTally(done, (row) => row.protocol ?? "?")}`
		)
	}
}

const browser = await chromium.launch({
	headless: true,
	args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
})

const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)

await cdp.send("Network.enable")
await cdp.send("Network.setCacheDisabled", { cacheDisabled: false })

const cdpURLs = new Set<string>()

cdp.on("Network.requestWillBeSent", (event) => {
	cdpURLs.add(event.request.url)

	const url = new URL(event.request.url)

	if (url.host === pageOrigin) return

	records.set(event.requestId, {
		url: event.request.url,
		host: url.hostname,
		phase,
		start: event.timestamp * 1000,
		bytes: 0,
	})
})

cdp.on("Network.responseReceived", (event) => {
	const record = records.get(event.requestId)

	if (!record) return

	const headers = event.response.headers

	record.status = event.response.status
	record.protocol = event.response.protocol
	record.fromCache = event.response.fromDiskCache || event.response.fromServiceWorker
	record.connectionID = event.response.connectionId

	record.cacheStatus =
		headers["cf-cache-status"] ??
		headers["CF-Cache-Status"] ??
		(headers["x-cache"] ? `x-cache:${headers["x-cache"]}` : undefined)
})

cdp.on("Network.loadingFinished", (event) => {
	const record = records.get(event.requestId)

	if (!record) return

	record.end = event.timestamp * 1000
	record.bytes = event.encodedDataLength
	totalBytes += event.encodedDataLength
})

cdp.on("Network.loadingFailed", (event) => {
	const record = records.get(event.requestId)

	if (!record) return

	record.end = event.timestamp * 1000
	record.canceled = event.canceled
	record.failed = event.errorText
})

// The page's CDP session doesn't see requests made from MapLibre's web workers (vector tiles, TileJSON).
// Playwright's page events include them, so a finished request whose URL the CDP
// session never recorded came from a worker.
const workerRecords = new Map<object, RequestRecord>()

page.on("request", (request) => {
	const url = new URL(request.url())

	if (url.host === pageOrigin) return

	workerRecords.set(request, { url: request.url(), host: url.hostname, phase, start: performance.now(), bytes: 0 })
})

page.on("requestfinished", async (request) => {
	const record = workerRecords.get(request)

	if (!record || cdpURLs.has(record.url)) return

	records.set(`worker-${records.size}`, record)
	record.end = performance.now()

	const response = await request.response()
	const headers = (await response?.allHeaders()) ?? {}
	const sizes = await request.sizes()

	record.status = response?.status()
	record.protocol = "worker"
	record.cacheStatus = headers["cf-cache-status"] ?? (headers["x-cache"] ? `x-cache:${headers["x-cache"]}` : undefined)
	record.bytes = sizes.responseBodySize + sizes.responseHeadersSize
	totalBytes += record.bytes
})

page.on("requestfailed", (request) => {
	const record = workerRecords.get(request)

	if (!record || cdpURLs.has(record.url)) return

	const text = request.failure()?.errorText ?? "failed"

	records.set(`worker-${records.size}`, record)
	record.end = performance.now()
	record.canceled = text.includes("ABORTED")
	record.failed = text
})

page.on("console", (message) => {
	if (message.type() === "error" || message.type() === "warning") {
		console.log(`[page ${message.type()}] ${message.text().slice(0, 200)}`)
	}
})

const budgetTimer = setInterval(() => {
	if (totalBytes > byteBudget) {
		console.error(`byte budget exceeded: ${totalBytes} > ${byteBudget}`)

		void browser.close().then(() => process.exit(2))
	}
}, 250)

/**
 * Waits until the map has stopped moving and every source, terrain included, has loaded its tiles.
 *
 * `GeocoderFixture.waitForMapIdle` in the Playwright suite skips the terrain sources
 * because no assertion reads them.
 * This measurement counts their traffic, so it waits for them too.
 */
async function waitForMapIdle(timeout = 30_000): Promise<void> {
	await page.waitForFunction(
		() => {
			const map = Reflect.get(globalThis, "__mailwomanMapCanvas") as
				| { loaded: () => boolean; isMoving: () => boolean; areTilesLoaded: () => boolean }
				| undefined

			return map != null && map.loaded() && !map.isMoving() && map.areTilesLoaded()
		},
		undefined,
		{ timeout, polling: 100 }
	)
}

async function flyTo(center: readonly [number, number], zoom: number, duration: number): Promise<void> {
	await page.evaluate(
		([c, z, d]) => {
			const map = Reflect.get(globalThis, "__mailwomanMapCanvas") as { flyTo: (options: object) => void }

			map.flyTo({ center: c, zoom: z, duration: d, essential: true })
		},
		[center, zoom, duration] as const
	)
}

await page.goto(values.url, { waitUntil: "domcontentloaded" })
await page.waitForFunction(() => Reflect.has(globalThis, "__mailwomanMapCanvas"), undefined, { timeout: 60_000 })
await waitForMapIdle(60_000)

const settledFlights = [
	{ label: "A1-london-z11", center: [-0.1276, 51.5072], zoom: 11, duration: 2500 },
	{ label: "A2-paris-z12", center: [2.3522, 48.8566], zoom: 12, duration: 2000 },
	{ label: "A3-nyc-z12", center: [-74.006, 40.7128], zoom: 12, duration: 3000 },
] as const

for (const flight of settledFlights) {
	phase = flight.label
	await flyTo(flight.center, flight.zoom, flight.duration)
	await page.waitForTimeout(flight.duration + 100)
	await waitForMapIdle()
}

const interruptedFlights = [
	[[139.6917, 35.6895], 12],
	[[151.2093, -33.8688], 11],
	[[-43.1729, -22.9068], 11],
	[[37.6173, 55.7558], 12],
	[[18.4241, -33.9249], 11],
] as const

phase = "B-churn"

for (const [center, zoom] of interruptedFlights) {
	await flyTo(center, zoom, 2500)
	await page.waitForTimeout(600)
}

await page.waitForTimeout(2600)
await waitForMapIdle()

clearInterval(budgetTimer)
await browser.close()

const all = [...records.values()]

summarize(
	"boot (initial load to idle)",
	all.filter((row) => row.phase === "boot")
)

summarize(
	"A (three settled flights)",
	all.filter((row) => row.phase.startsWith("A"))
)

summarize(
	"B (five interrupted flights)",
	all.filter((row) => row.phase === "B-churn")
)

summarize("total", all)

const urlCounts = tally(all, (row) => row.url).filter(([, count]) => count > 1)

console.log(
	`\nduplicate URLs: ${urlCounts.length} (requests beyond unique URLs: ${all.length - new Set(all.map((row) => row.url)).size})`
)

for (const [url, count] of urlCounts.slice(0, 8)) {
	console.log(`  ${count}x ${url}`)
}

console.log(`\ntotal bytes ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
