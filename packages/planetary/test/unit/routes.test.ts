/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathForRoute, routeForPath, viewportFromSearch } from "@mailwoman/planetary/routes"
import { describe, expect, test } from "vitest"

describe("routeForPath", () => {
	test("the root is the map, with a trailing slash or none", () => {
		expect(routeForPath("/")).toEqual({ kind: "map" })
		expect(routeForPath("")).toEqual({ kind: "map" })
		expect(routeForPath("///")).toEqual({ kind: "map" })
	})

	test("a feature path carries the id", () => {
		expect(routeForPath("/feature/11150")).toEqual({ kind: "feature", id: "11150" })
		expect(routeForPath("/feature/11150/")).toEqual({ kind: "feature", id: "11150" })
	})

	test("a feature path without an id, a non-numeric id, or an unknown path is null", () => {
		expect(routeForPath("/feature/")).toBeNull()
		expect(routeForPath("/feature/tycho")).toBeNull()
		expect(routeForPath("/nowhere")).toBeNull()
		expect(routeForPath("/feature/11150/extra")).toBeNull()
	})

	test("pathForRoute inverts routeForPath", () => {
		for (const path of ["/", "/feature/11150"]) {
			expect(pathForRoute(routeForPath(path)!)).toBe(path)
		}
	})
})

describe("viewportFromSearch", () => {
	test("reads the three numbers", () => {
		expect(viewportFromSearch("?lon=-11.2&lat=-43.3&z=5")).toEqual({ longitude: -11.2, latitude: -43.3, zoom: 5 })
	})

	test("a missing or malformed value is null, never a partial viewport", () => {
		expect(viewportFromSearch("")).toBeNull()
		expect(viewportFromSearch("?lon=-11.2&lat=-43.3")).toBeNull()
		expect(viewportFromSearch("?lon=west&lat=-43.3&z=5")).toBeNull()
		expect(viewportFromSearch("?lon=&lat=-43.3&z=5")).toBeNull()
		expect(viewportFromSearch("?lon=Infinity&lat=0&z=1")).toBeNull()
	})
})
