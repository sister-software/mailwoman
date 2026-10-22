/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import {
	cameraFromLocation,
	cameraFromPath,
	cameraFromSearch,
	pathWithCamera,
	queryFromSearch,
	Route,
	routeForPath,
	runtimeModeFromSearch,
} from "#routes"

describe("cameraFromPath", () => {
	test("reads Google Maps' /@lat,lon,zoomz segment, latitude first", () => {
		expect(cameraFromPath("/@51.0716963,0.7244254,9z")).toEqual({ center: [0.7244254, 51.0716963], zoom: 9 })
		expect(cameraFromPath("/debug/@35.6812,139.764,16.5z")).toEqual({ center: [139.764, 35.6812], zoom: 16.5 })
		expect(cameraFromPath("/@-33.8688,151.2093")).toEqual({ center: [151.2093, -33.8688], zoom: null })
	})

	test("refuses a path without a segment or with an out-of-range latitude", () => {
		expect(cameraFromPath("/")).toBeNull()
		expect(cameraFromPath("/@139.764,35.6812,16z")).toBeNull()
	})
})

describe("cameraFromLocation", () => {
	test("prefers the path segment and falls back to ?center=", () => {
		expect(cameraFromLocation("/@51.5,-0.12,9z", "?center=139.764,35.6812")).toEqual({ center: [-0.12, 51.5], zoom: 9 })
		expect(cameraFromLocation("/", "?center=139.764,35.6812&zoom=16")).toEqual({ center: [139.764, 35.6812], zoom: 16 })
	})
})

describe("pathWithCamera", () => {
	test("writes /@lat,lon,zoomz after the route, keeping the query and dropping ?center=", () => {
		const url = new URL("https://earth.mailwoman.ai/debug/@1,2,3z?q=Tokyo&center=1,2&zoom=3")

		expect(pathWithCamera(url, [0.72442541234, 51.07169634567], 9)).toBe("/debug/@51.0716963,0.7244254,9z?q=Tokyo")

		expect(pathWithCamera(new URL("https://earth.mailwoman.ai/"), [139.764, 35.6812], 16.504)).toBe(
			"/@35.6812,139.764,16.5z"
		)
	})

	test("round-trips through cameraFromPath", () => {
		const path = pathWithCamera(new URL("https://earth.mailwoman.ai/"), [0.7244254, 51.0716963], 9)

		expect(cameraFromPath(path)).toEqual({ center: [0.7244254, 51.0716963], zoom: 9 })
		expect(routeForPath(path)).toBe(Route.Geocoder)
	})
})

describe("cameraFromSearch", () => {
	test("reads center as lon,lat and an optional zoom", () => {
		expect(cameraFromSearch("?center=139.764,35.6812&zoom=16")).toEqual({ center: [139.764, 35.6812], zoom: 16 })
		expect(cameraFromSearch("?center=-74.006,40.7128")).toEqual({ center: [-74.006, 40.7128], zoom: null })
		expect(cameraFromSearch("?center=139.764,35.6812&zoom=far")).toEqual({ center: [139.764, 35.6812], zoom: null })
	})

	test("refuses a center that is missing, malformed or out of range", () => {
		expect(cameraFromSearch("")).toBeNull()
		expect(cameraFromSearch("?zoom=12")).toBeNull()
		expect(cameraFromSearch("?center=139.764")).toBeNull()
		expect(cameraFromSearch("?center=tokyo,station")).toBeNull()
		expect(cameraFromSearch("?center=35.6812,139.764")).toBeNull()
	})
})

describe("runtimeModeFromSearch", () => {
	test("only ?runtime=fake selects the fake runtime", () => {
		expect(runtimeModeFromSearch("?runtime=fake")).toBe("fake")
		expect(runtimeModeFromSearch("?q=Chicago&runtime=fake")).toBe("fake")
		expect(runtimeModeFromSearch("")).toBe("real")
		expect(runtimeModeFromSearch("?runtime=real")).toBe("real")
		expect(runtimeModeFromSearch("?runtime=")).toBe("real")
	})
})

describe("routeForPath", () => {
	test.each([
		["/", Route.Geocoder],
		["/debug", Route.Debug],
		["/trace", Route.Trace],
		["/debug/", Route.Debug],
		["", Route.Geocoder],
	])("%s → %s", (pathname, route) => {
		expect(routeForPath(pathname)).toBe(route)
	})

	test("an unknown path is null, not the geocoder", () => {
		expect(routeForPath("/demo")).toBeNull()
		expect(routeForPath("/debug/extra")).toBeNull()
	})
})

describe("queryFromSearch", () => {
	test("reads ?q= and decodes it", () => {
		expect(queryFromSearch("?q=3215%20SE%20Clinton%20St%20Portland%20OR")).toBe("3215 SE Clinton St Portland OR")
	})

	test("a missing or blank q is null", () => {
		expect(queryFromSearch("")).toBeNull()
		expect(queryFromSearch("?q=")).toBeNull()
		expect(queryFromSearch("?q=%20%20")).toBeNull()
		expect(queryFromSearch("?other=1")).toBeNull()
	})
})
