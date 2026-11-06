/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import { LandmarkSource, RemoteLandmarkLookup } from "#remote-landmark"

const BASE_URL = new URL("https://places.invalid/")

describe("RemoteLandmarkLookup", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("asks the route for one name from one layer and returns its hits", async () => {
		const fetchRoute = vi.fn(async (_url: URL) => Response.json({ hits: [{ qid: "W1" }] }))

		vi.stubGlobal("fetch", fetchRoute)

		const hits = await new RemoteLandmarkLookup(BASE_URL, LandmarkSource.OpenStreetMap).find("Piedmont Park")

		expect(hits).toEqual([{ qid: "W1" }])

		expect(String(fetchRoute.mock.calls[0]![0])).toBe(
			"https://places.invalid/v1/landmarks?name=Piedmont+Park&source=openstreetmap"
		)
	})

	it("throws on a failed answer, because an empty list would claim the layer holds no such place", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 503 }))
		)

		await expect(new RemoteLandmarkLookup(BASE_URL, LandmarkSource.Wikidata).find("Central Park")).rejects.toThrow(
			"The wikidata landmark route answered 503"
		)
	})
})
