/**
 * @file Disk-backed route cache for the heavy data-origin fetches (the ~39 MB ONNX model, the
 *   gazetteer's sqlite range reads, the FSTs, basemap tiles).
 *
 *   Playwright gives every test a fresh browser context, so the HTTP cache is cold per test and
 *   each of the real-runtime specs re-downloaded the model. This fixture serves those GET/HEAD
 *   requests from `.cache/e2e-data/` instead, fetching over the network only on a miss.
 *
 *   sqlite-wasm reads the gazetteer through HTTP `Range` requests, so the handler answers ranges
 *   from the cached whole file with proper 206 responses.
 */

import { readFileRange, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import type { Page, Route } from "@playwright/test"

/**
 * Origins whose GETs are cached.
 * The tile worker serves the basemap the same specs load.
 */
const CACHED_ORIGINS = ["https://public.mailwoman.ai/", "https://tiles.mailwoman.ai/"] as const

const CONTENT_TYPES: Record<string, string> = {
	".json": "application/json",
	".wasm": "application/wasm",
	".onnx": "application/octet-stream",
	".model": "application/octet-stream",
	".db": "application/octet-stream",
	".sqlite": "application/octet-stream",
	".fst": "application/octet-stream",
	".pbf": "application/x-protobuf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
}

function contentTypeFor(pathname: string): string {
	const dot = pathname.lastIndexOf(".")

	return dot === -1 ? "application/octet-stream" : (CONTENT_TYPES[pathname.slice(dot)] ?? "application/octet-stream")
}

/**
 * Map a request URL to its cache file: `.cache/e2e-data/<host>/<pathname>`.
 */
function cacheFilePath(url: URL): string {
	return `.cache/e2e-data/${url.host}${decodeURIComponent(url.pathname)}`
}

interface ByteRange {
	start: number
	end: number
}

/**
 * Parse a single-range `Range: bytes=start-end` header against the file's size.
 */
function parseRange(header: string | undefined, size: number): ByteRange | null {
	if (!header) return null

	const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim())

	if (!match) return null

	const start = Number(match[1])
	const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1

	return start <= end ? { start, end } : null
}

async function fulfillFromCache(route: Route, filePath: string, rangeHeader: string | undefined): Promise<void> {
	const stats = await tryStat(filePath)

	if (!stats?.isFile()) throw new Error("not cached")

	if (route.request().method() === "HEAD") {
		return route.fulfill({
			status: 200,
			headers: { "content-length": String(stats.size), "accept-ranges": "bytes" },
		})
	}

	const range = parseRange(rangeHeader, stats.size)

	if (range) {
		return route.fulfill({
			status: 206,
			headers: {
				"content-range": `bytes ${range.start}-${range.end}/${stats.size}`,
				"accept-ranges": "bytes",
				"content-type": contentTypeFor(filePath),
			},
			body: await readFileRange(filePath, range.start, range.end - range.start + 1),
		})
	}

	return route.fulfill({
		status: 200,
		headers: { "content-type": contentTypeFor(filePath), "accept-ranges": "bytes" },
		body: await readLocalBuffer(filePath),
	})
}

async function fetchAndCache(url: URL, filePath: string): Promise<void> {
	const response = await fetch(url)

	if (!response.ok) {
		throw new Error(`cache fill failed: ${response.status} ${response.statusText} for ${url.href}`)
	}

	await writeLocalBuffer(Buffer.from(await response.arrayBuffer()), filePath)
}

/**
 * Route the data and tile origins through the on-disk cache.
 *
 * Skipped when `MAILWOMAN_EARTH_URL` points the suite at a deployment.
 * The production smoke exists to exercise the real bucket, and a cache would mask the failures it looks for.
 */
export async function installDataRouteCache(page: Page): Promise<void> {
	// oxlint-disable-next-line sister-software/no-process-globals -- fixtures run in Playwright's Node process
	if (process.env["MAILWOMAN_EARTH_URL"]) return

	for (const origin of CACHED_ORIGINS) {
		await page.route(`${origin}**`, async (route) => {
			const request = route.request()

			if (request.method() !== "GET" && request.method() !== "HEAD") {
				return route.continue()
			}

			const url = new URL(request.url())
			const filePath = cacheFilePath(url)
			const rangeHeader = request.headers()["range"]

			try {
				return await fulfillFromCache(route, filePath, rangeHeader)
			} catch {
				// A miss (or a corrupt entry) falls through to a network fill.
			}

			// A range request on a miss goes to the network as it is.
			// The file behind it is a multi-gigabyte database (the 2026-08-25b gazetteer is 2.9 GB),
			// and a whole-file fill would hold it in memory and outlast the test's budget.
			if (rangeHeader) {
				return route.continue()
			}

			try {
				await fetchAndCache(url, filePath)
			} catch {
				// Offline or bucket trouble: let the request hit the network so the failure
				// surfaces as the app's own load error rather than a fixture exception.
				return route.continue()
			}

			return fulfillFromCache(route, filePath, rangeHeader)
		})
	}
}
