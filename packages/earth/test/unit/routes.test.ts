/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { queryFromSearch, Route, routeForPath } from "@mailwoman/earth/routes"
import { describe, expect, test } from "vitest"

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
