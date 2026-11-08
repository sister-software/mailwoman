// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { StreetRouteResponse } from "@mailwoman/resolver-wof-wasm/remote/street"
import { env, exports } from "cloudflare:workers"
import { beforeAll, describe, expect, test } from "vitest"

import { candidateDatabaseKey, LANDMARK_DATABASE_KEY, OSM_PLACES_DATABASE_KEY, STREET_TABLE_KEY } from "#index"

const bytes = (base64: string) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))

beforeAll(async () => {
	await env.PUBLIC_BUCKET.put(candidateDatabaseKey(), bytes(env.CANDIDATE_FIXTURE_BASE64))
	await env.PUBLIC_BUCKET.put(LANDMARK_DATABASE_KEY, bytes(env.LANDMARK_FIXTURE_BASE64))
	await env.OSM_PLACES_BUCKET.put(OSM_PLACES_DATABASE_KEY, bytes(env.OSM_PLACES_FIXTURE_BASE64))
	await env.PUBLIC_BUCKET.put(STREET_TABLE_KEY, bytes(env.STREET_FIXTURE_BASE64))
})

describe("the street routes", () => {
	const read = async (path: string) => {
		const response = await exports.default.fetch(`https://places.invalid${path}`)

		return {
			status: response.status,
			body: response.ok ? ((await response.json()) as StreetRouteResponse<never>) : null,
		}
	}

	test("answers a street by its place's id, with the source's credit", async () => {
		const { body } = await read("/v1/streets?street=High%20Street&place=85786019")

		expect(body?.hits).toMatchObject([{ streetID: 1, name: "High Street", lat: 51.45, distanceM: null }])
		expect(body?.license).toBe("OGL-UK-3.0")
	})

	test("answers a street near a point, skipping a namesake outside the radius", async () => {
		const { body } = await read("/v1/streets?street=High%20Street&near=53.1,-2.1&radius=1000")

		expect(body?.hits).toMatchObject([{ streetID: 2 }])
	})

	test("answers a crossing in either order inside its place", async () => {
		const { body } = await read("/v1/crossings?first=High%20Street&second=Church%20Lane&place=85786019")

		expect(body?.hits).toMatchObject([{ lat: 51.45, lon: -2.55, nodes: 1 }])
	})

	test("refuses an unscoped street, a wide radius and too many places", async () => {
		expect((await read("/v1/streets?street=High%20Street")).status).toBe(400)
		expect((await read("/v1/streets?street=High%20Street&near=53.1,-2.1&radius=99999")).status).toBe(400)
		expect((await read(`/v1/crossings?first=a&second=b&${"place=1&".repeat(9)}`)).status).toBe(400)
	})
})

describe("the landmark route", () => {
	const read = (query: string) => exports.default.fetch(`https://places.invalid/v1/landmarks?${query}`)

	test("answers a Wikidata name with its hits and CC0 license", async () => {
		const response = await read("name=Central%20Park&source=wikidata")
		const answer = (await response.json()) as { hits: Array<{ qid: string }>; license: string }

		expect(response.status).toBe(200)
		expect(answer.hits.map(({ qid }) => qid)).toEqual(["Q160409"])
		expect(answer.license).toBe("CC0-1.0")
	})

	test("credits OpenStreetMap beside an OpenStreetMap hit", async () => {
		const answer = (await (await read("name=Piedmont%20Park&source=openstreetmap")).json()) as {
			hits: Array<{ qid: string }>
			attribution: string
			license: string
		}

		expect(answer.hits.map(({ qid }) => qid)).toEqual(["W1"])
		expect(answer.attribution).toBe("© OpenStreetMap contributors")
		expect(answer.license).toBe("ODbL-1.0")
	})

	test("bounds the rows one name reads", async () => {
		const answer = (await (await read("name=Crowded&source=openstreetmap")).json()) as { hits: unknown[] }

		expect(answer.hits).toHaveLength(100)
	})

	test("refuses a request with no name or an unknown source", async () => {
		expect((await read("source=wikidata")).status).toBe(400)
		expect((await read("name=Central%20Park&source=every")).status).toBe(400)
	})
})

describe("the gazetteer Worker's RPC entry point", () => {
	test("findPlace returns the candidate table's places for a name, most important first", async () => {
		const candidates = await exports.default.findPlace({ text: "Springfield", placetype: "locality", limit: 3 })

		expect(candidates.map(({ id }) => id)).toEqual([85_971_363, 85_950_393, 85_940_195])
		expect(candidates[0]).toMatchObject({ name: "Springfield", placetype: "locality", country: "US" })
	})

	test("findPlace re-ranks by a bias point near one of the places", async () => {
		const [nearest] = await exports.default.findPlace({
			text: "Springfield",
			placetype: "locality",
			limit: 3,
			bias: [{ lat: 39.8, lon: -89.6 }],
		})

		expect(nearest?.id).toBe(85_940_195)
	})

	test("readStats reports the reads the open database has made", async () => {
		await exports.default.findPlace({ text: "Springfield", placetype: "locality", limit: 1 })

		const stats = await exports.default.readStats()

		expect(stats?.requests).toBeGreaterThan(0)
	})

	test("fetch answers 404, because the Worker serves its binding only", async () => {
		const response = await exports.default.fetch("https://gazetteer.invalid/")

		expect(response.status).toBe(404)
	})
})
