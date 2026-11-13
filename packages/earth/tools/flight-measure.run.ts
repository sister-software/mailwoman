// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Measures one long camera flight that a search result starts: frame times,
 *   long animation frames, requests by host, kind and tile zoom, and the entries
 *   the flight adds to the service worker's tile cache.
 *
 *   The canned runtime answers every search with New York, so the page starts over Tokyo
 *   and the result moves the camera across the Pacific through the app's own result camera.
 *   Requests count as mid-flight between the map's `movestart` and `moveend`.
 *
 *   Headless Chromium draws with SwiftShader, so frame times compare one build with
 *   another on the same machine rather than predicting a device.
 *
 *   Start the preview server
 *   first (`yarn workspace @mailwoman/earth build && yarn workspace @mailwoman/earth preview`).
 *
 *   Usage: node packages/earth/tools/flight-measure.run.ts [--url http://localhost:7771/] [--proxy <url>]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { percentile } from "@mailwoman/core/stats"
import { chromium } from "@playwright/test"

const { values } = parseArguments({
	options: {
		url: { type: "string", default: "http://localhost:7771/" },
		// An HTTP proxy for the tile and data hosts, such as a sandbox's egress proxy.
		proxy: { type: "string" },
		// The result shape: `bounds` for a locality, `center` for an address point.
		target: { type: "string", default: "bounds" },
		// Calls fitBounds or flyTo directly, as the result camera did before long moves jumped.
		direct: { type: "boolean", default: false },
	},
})

/**
 * The camera the flight starts from: central Tokyo at city zoom.
 */
const START = "@35.6812,139.7671,12z"

/**
 * How long the measurement waits for the map to settle after the flight, in milliseconds.
 */
const SETTLE_TIMEOUT_MS = 60_000

const TILE_CACHE_NAME = "mailwoman-tiles-g1"

/**
 * The result camera targets a New York result produces: a locality's bounds,
 * as the place renderer pads them, and an address point at zoom 17.
 */
const TARGETS = {
	bounds: {
		kind: "bounds",
		bounds: [
			[-74.156, 40.5628],
			[-73.856, 40.8628],
		],
		padding: 40,
	},
	center: { kind: "center", center: [-73.9857, 40.7484], zoom: 17 },
} as const

interface RequestRow {
	host: string
	kind: string
	zoom: number | null
	phase: string
}

/**
 * The tile zoom in a request URL's `/z/x/y` path, or null.
 */
function tileZoom(url: URL): number | null {
	const match = /\/(\d{1,2})\/\d+\/\d+(?:\.\w+)?$/.exec(url.pathname)

	return match ? Number(match[1]) : null
}

/**
 * The first path segment of a request URL.
 * On the tile host it identifies the tileset or data family.
 */
function requestKind(url: URL): string {
	return url.pathname.split("/").find((segment) => segment.length > 0) ?? "/"
}

function tally(rows: readonly RequestRow[], key: (row: RequestRow) => string | number | null): string {
	const counts = new Map<string, number>()

	for (const row of rows) {
		const value = String(key(row))

		counts.set(value, (counts.get(value) ?? 0) + 1)
	}

	return [...counts]
		.toSorted((a, b) => b[1] - a[1])
		.map(([value, count]) => `${value}:${count}`)
		.join(" ")
}

const browser = await chromium.launch({
	headless: true,
	args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
	...(values.proxy ? { proxy: { server: values.proxy, bypass: "localhost,127.0.0.1" } } : {}),
})

const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
const pageHost = new URL(values.url).host
const rows: RequestRow[] = []
let phase = "boot"

await page.exposeFunction("__flightPhase", (next: string) => {
	phase = next
})

context.on("request", (request) => {
	const url = new URL(request.url())

	if (url.host === pageHost) return

	rows.push({ host: url.hostname, kind: requestKind(url), zoom: tileZoom(url), phase })
})

async function waitForMapIdle(): Promise<void> {
	await page.waitForFunction(
		() => {
			const map = Reflect.get(globalThis, "__mailwomanMapCanvas") as
				| { loaded: () => boolean; isMoving: () => boolean; areTilesLoaded: () => boolean }
				| undefined

			return map != null && map.loaded() && !map.isMoving() && map.areTilesLoaded()
		},
		undefined,
		{ timeout: SETTLE_TIMEOUT_MS, polling: 100 }
	)
}

async function tileCacheEntries(): Promise<number | null> {
	// The tools project has no DOM library, so page globals are read through `Reflect` with the types used.
	return page.evaluate(async (name) => {
		const storage = Reflect.get(globalThis, "caches") as {
			has: (cacheName: string) => Promise<boolean>
			open: (cacheName: string) => Promise<{ keys: () => Promise<unknown[]> }>
		}

		if (!(await storage.has(name))) return null

		return (await (await storage.open(name)).keys()).length
	}, TILE_CACHE_NAME)
}

if (!(values.target in TARGETS)) {
	throw new Error(`--target must be one of ${Object.keys(TARGETS).join(", ")}, got ${values.target}`)
}

// `?no-model` draws the full basemap without downloading the model.
const start = new URL(START, values.url)

start.searchParams.set("no-model", "")

// The first visit installs the service worker.
// The second visit runs under it, as a returning reader's would.
await page.goto(start.href, { waitUntil: "load" })

await page.waitForFunction(
	() => {
		const browserNavigator = Reflect.get(globalThis, "navigator") as { serviceWorker?: { controller: unknown } }

		return Boolean(browserNavigator.serviceWorker?.controller)
	},
	undefined,
	{ timeout: 30_000 }
)

await page.reload({ waitUntil: "load" })
await page.waitForFunction(() => Reflect.has(globalThis, "__mailwomanMapCanvas"), undefined, { timeout: 60_000 })
await waitForMapIdle()

const cacheBefore = await tileCacheEntries()

// The page records every frame and long animation frame from the first `movestart`
// until the tool stops it once the map is idle, and the time of each `moveend`.
// A long move can be a jump followed by an animation, each with its own start and end.
await page.evaluate(() => {
	const map = Reflect.get(globalThis, "__mailwomanMapCanvas") as {
		on: (type: string, listener: () => void) => void
	}

	const report = Reflect.get(globalThis, "__flightPhase") as (phase: string) => void
	const state = { recording: false, startedAt: 0, lastMoveEndAt: 0, frames: [] as number[], longFrames: [] as number[] }
	const nextFrame = Reflect.get(globalThis, "requestAnimationFrame") as (callback: (now: number) => void) => number
	let last = 0

	const tick = (now: number) => {
		if (state.recording) {
			state.frames.push(now - last)
		}

		last = now
		nextFrame(tick)
	}

	nextFrame(tick)

	// Node's types list only Node's entry types, so the browser observer is read through `Reflect` too.
	const BrowserObserver = Reflect.get(globalThis, "PerformanceObserver") as {
		supportedEntryTypes: readonly string[]
		new (callback: (list: { getEntries: () => Array<{ duration: number }> }) => void): {
			observe: (options: { type: string }) => void
		}
	}

	if (BrowserObserver.supportedEntryTypes.includes("long-animation-frame")) {
		new BrowserObserver((list) => {
			if (state.recording) {
				for (const entry of list.getEntries()) {
					state.longFrames.push(entry.duration)
				}
			}
		}).observe({ type: "long-animation-frame" })
	}

	map.on("movestart", () => {
		if (state.startedAt) return

		state.recording = true
		state.startedAt = performance.now()
		report("move")
	})

	map.on("moveend", () => {
		state.lastMoveEndAt = performance.now()
	})

	Reflect.set(globalThis, "__flightState", state)
})

// `--direct` makes the call the result camera made before long moves jumped:
// an animated fitBounds for a bounds target and an animated flyTo for a center target.
// Otherwise a build that exposes the app's result-camera function runs the move through it.
await page.evaluate(
	([target, direct]) => {
		const apply = Reflect.get(globalThis, "__mailwomanApplyCameraTarget") as ((target: object) => void) | undefined

		const map = Reflect.get(globalThis, "__mailwomanMapCanvas") as {
			fitBounds: (bounds: unknown, options: object) => void
			flyTo: (options: object) => void
		}

		if (apply && !direct) {
			apply(target)
		} else if (target.kind === "bounds") {
			map.fitBounds(target.bounds, { padding: target.padding })
		} else {
			map.flyTo({ center: target.center, zoom: target.zoom })
		}
	},
	[TARGETS[values.target as keyof typeof TARGETS], values.direct] as const
)

await waitForMapIdle()

const { frames, longFrames, moveMs, idleMs } = await page.evaluate(() => {
	const state = Reflect.get(globalThis, "__flightState") as {
		recording: boolean
		startedAt: number
		lastMoveEndAt: number
		frames: number[]
		longFrames: number[]
	}

	state.recording = false

	return {
		frames: state.frames,
		longFrames: state.longFrames,
		moveMs: state.lastMoveEndAt - state.startedAt,
		idleMs: performance.now() - state.startedAt,
	}
})

phase = "after"

const cacheAfter = await tileCacheEntries()

await browser.close()

const moved = rows.filter((row) => row.phase === "move")
const format = (value: number | null) => (value == null ? "-" : value.toFixed(1))

console.log(
	`camera moving: ${moveMs.toFixed(0)} ms; until tiles loaded: ${idleMs.toFixed(0)} ms; ${frames.length} frames`
)
console.log(
	`frame ms: p50 ${format(percentile(frames, 50))} p95 ${format(percentile(frames, 95))} ` +
		`max ${format(frames.length ? Math.max(...frames) : null)}`
)
console.log(
	`long animation frames: ${longFrames.length}, total ${longFrames.reduce((sum, ms) => sum + ms, 0).toFixed(0)} ms`
)
console.log(`requests from movestart to idle: ${moved.length}`)
console.log(`  by host: ${tally(moved, (row) => row.host)}`)
console.log(`  by kind: ${tally(moved, (row) => row.kind)}`)
console.log(`  by zoom: ${tally(moved, (row) => row.zoom)}`)
console.log(`service-worker tile cache entries: ${cacheBefore ?? "-"} → ${cacheAfter ?? "-"}`)
