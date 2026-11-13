// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Regression tests for the `bounds` camera path: an animated `fitBounds` must omit the
 *   `duration` KEY, since maplibre's `Camera.flyTo` branches on `'duration' in options`
 *   and an undefined value coerces to `NaN`.
 */

import { MapCanvas, type MapCanvasStyle } from "@mailwoman/react/map/MapCanvas"
import {
	applyCameraTarget,
	type CameraMap,
	fitBoundsOptionsFor,
	LONG_MOVE_OVERVIEW_ZOOM,
	ResultCamera,
} from "@mailwoman/react/map/ResultCamera"
import { act } from "react"
import type { MapRef } from "react-map-gl/maplibre"
import { afterEach, describe, expect, test, vi } from "vitest"

import { JUMP_FADE_MS, type JumpCurtain } from "#map/jump-curtain"
import type { MapCameraTarget } from "#map/place-render"

import { renderComponent } from "../../test/render.tsx"

const STUB_STYLE: MapCanvasStyle = {
	version: 8,
	name: "result-camera-test-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/**
 * A real-extent box, so `fitBounds` computes a full flight rather than the degenerate short-path branch.
 */
const BOUNDS_TARGET: MapCameraTarget = {
	kind: "bounds",
	bounds: [
		[-74.1, 40.6],
		[-73.9, 40.8],
	],
	padding: 40,
}

/**
 * Poll `get` until truthy or `timeout` ms elapse, flushing react-map-gl's async effects inside `act()`.
 */
async function settle<T>(get: () => T | null, timeout = 8000): Promise<T | null> {
	const start = Date.now()
	let found: T | null | undefined = null

	await act(async () => {
		while (Date.now() - start < timeout) {
			found = get()

			if (found) break

			await new Promise((resolve) => {
				setTimeout(resolve, 50)
			})
		}
	})

	return found ?? null
}

test("an animated fitBounds omits the duration KEY — passing it as undefined is what produced NaN", () => {
	const animated = fitBoundsOptionsFor(40, true)

	// The key must be absent rather than merely undefined: `duration: null` satisfies maplibre's
	// `'duration' in options` test and coerces to `NaN`, and `toBeUndefined()` would pass against the bug.
	expect(Object.hasOwn(animated, "duration")).toBe(false)
	expect(animated.padding).toBe(40)

	const jumped = fitBoundsOptionsFor(40, false)
	expect(jumped.duration).toBe(0)
})

test("a bounds target drives the live map to the box without a NaN ease frame", async () => {
	let mapRef: MapRef | null = null

	const { container } = renderComponent(
		<MapCanvas
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: 0, latitude: 51.5, zoom: 3 }}
			style={{ width: "600px", height: "400px" }}
			mapRef={(ref) => {
				mapRef = ref
			}}
		>
			<ResultCamera target={BOUNDS_TARGET} />
		</MapCanvas>
	)

	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	// GL surface, best-effort as in the sibling map tests: its absence means no software WebGL here rather than a fault.
	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (!mapEl) return

	// Read the ref lazily: it is assigned in a callback TypeScript cannot see, so reading it directly narrows to `never`.
	const getMap = () => mapRef?.getMap()

	// Under the bug the flight throws on frame 1 and the camera never leaves (0, 51.5),
	// so a moved center is the assertion.
	const arrived = await settle(() => {
		const center = getMap()?.getCenter()

		return center && Math.abs(center.lng - -74) < 1 && Math.abs(center.lat - 40.7) < 1 ? center : null
	})

	expect(arrived, "the camera never reached the bounds — the ease produced NaN").not.toBeNull()
	expect(Number.isFinite(getMap()?.getZoom())).toBe(true)
})

/**
 * A camera that records each move it's asked for, starting at `center` and `zoom`.
 */
function recordingCamera(center: { lng: number; lat: number }, zoom: number) {
	const calls: Array<[method: string, ...args: unknown[]]> = []

	const camera: CameraMap = {
		getCenter: () => center,
		getZoom: () => zoom,
		jumpTo: (options) => calls.push(["jumpTo", options]),
		flyTo: (options) => calls.push(["flyTo", options]),
		fitBounds: (bounds, options) => calls.push(["fitBounds", bounds, options]),
	}

	return { calls, camera }
}

/**
 * A curtain that records its steps into the same list as the camera's moves.
 */
function recordingCurtain(calls: Array<[method: string, ...args: unknown[]]>): JumpCurtain {
	return {
		cover: () => calls.push(["cover"]),
		reveal: () => calls.push(["reveal"]),
		remove: () => calls.push(["remove"]),
	}
}

const TOKYO = { lng: 139.7671, lat: 35.6812 }

describe("applyCameraTarget", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	test("a long move jumps over the target at the overview zoom, then animates in", () => {
		const { calls, camera } = recordingCamera(TOKYO, 12)

		applyCameraTarget(camera, BOUNDS_TARGET)

		expect(calls.map(([method]) => method)).toEqual(["jumpTo", "fitBounds"])
		expect(calls[0]![1]).toEqual({ center: [-74, 40.7], zoom: LONG_MOVE_OVERVIEW_ZOOM })
		expect(Object.hasOwn(calls[1]![2] as object, "duration")).toBe(false)
	})

	test("a long move from a lower zoom keeps that zoom for the jump", () => {
		const { calls, camera } = recordingCamera(TOKYO, 2)

		applyCameraTarget(camera, { kind: "center", center: [-73.9857, 40.7484], zoom: 17 })

		expect(calls[0]).toEqual(["jumpTo", { center: [-73.9857, 40.7484], zoom: 2 }])
		expect(calls[1]![0]).toBe("flyTo")
	})

	test("a short move animates without a jump", () => {
		const { calls, camera } = recordingCamera({ lng: -73.5, lat: 41 }, 12)

		applyCameraTarget(camera, BOUNDS_TARGET)

		expect(calls.map(([method]) => method)).toEqual(["fitBounds"])
	})

	test("a long move with a curtain fades in, jumps, fades out while animating in, then removes the curtain", () => {
		vi.useFakeTimers()

		try {
			const { calls, camera } = recordingCamera(TOKYO, 12)
			const curtain = recordingCurtain(calls)

			applyCameraTarget(camera, BOUNDS_TARGET, true, curtain)
			expect(calls.map(([method]) => method)).toEqual(["cover"])

			vi.advanceTimersByTime(JUMP_FADE_MS - 1)
			expect(calls.map(([method]) => method)).toEqual(["cover"])

			vi.advanceTimersByTime(1)
			expect(calls.map(([method]) => method)).toEqual(["cover", "jumpTo", "reveal", "fitBounds"])
			expect(calls[1]![1]).toEqual({ center: [-74, 40.7], zoom: LONG_MOVE_OVERVIEW_ZOOM })

			vi.advanceTimersByTime(JUMP_FADE_MS)
			expect(calls.map(([method]) => method)).toEqual(["cover", "jumpTo", "reveal", "fitBounds", "remove"])
		} finally {
			vi.useRealTimers()
		}
	})

	test("cancelling during the fade-in removes the curtain and leaves the camera where it was", () => {
		vi.useFakeTimers()

		try {
			const { calls, camera } = recordingCamera(TOKYO, 12)
			const cancel = applyCameraTarget(camera, BOUNDS_TARGET, true, recordingCurtain(calls))

			vi.advanceTimersByTime(JUMP_FADE_MS / 2)
			cancel()
			vi.advanceTimersByTime(JUMP_FADE_MS * 4)

			expect(calls.map(([method]) => method)).toEqual(["cover", "remove"])
		} finally {
			vi.useRealTimers()
		}
	})

	test("a short move with a curtain animates at once without fading", () => {
		const { calls, camera } = recordingCamera({ lng: -73.5, lat: 41 }, 12)

		applyCameraTarget(camera, BOUNDS_TARGET, true, recordingCurtain(calls))

		expect(calls.map(([method]) => method)).toEqual(["fitBounds"])
	})

	test("reduced motion with a curtain lands without fading or animating", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }))

		const { calls, camera } = recordingCamera(TOKYO, 12)

		applyCameraTarget(camera, { kind: "center", center: [-73.9857, 40.7484], zoom: 17 }, true, recordingCurtain(calls))

		expect(calls).toEqual([["jumpTo", { center: [-73.9857, 40.7484], zoom: 17 }]])
	})

	test("reduced motion lands without animating, however far the move", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }))

		const { calls, camera } = recordingCamera(TOKYO, 12)

		applyCameraTarget(camera, { kind: "center", center: [-73.9857, 40.7484], zoom: 17 })

		expect(calls).toEqual([["jumpTo", { center: [-73.9857, 40.7484], zoom: 17 }]])
	})
})
