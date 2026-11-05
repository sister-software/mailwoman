/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env, exports } from "cloudflare:workers"
import { beforeAll, describe, expect, test } from "vitest"

import { candidateDatabaseKey } from "#index"

beforeAll(async () => {
	const fixture = Uint8Array.from(atob(env.CANDIDATE_FIXTURE_BASE64), (character) => character.charCodeAt(0))

	await env.PUBLIC_BUCKET.put(candidateDatabaseKey(), fixture)
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
