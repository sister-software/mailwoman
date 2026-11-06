// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createMailwomanAPI } from "@mailwoman/api"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { stringifyJSON } from "@mailwoman/core/json"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { describe, expect, test, vi } from "vitest"

import { createEngineWorkerEngine, type ReleasePipeline } from "#engine"

type LookupQuery = Parameters<MailwomanLookupLike["findPlace"]>[0]

const SPRINGFIELDS = [
	{ id: 85_971_363, name: "Springfield", placetype: "locality", country: "US", lat: 37.21, lon: -93.29, score: 1 },
	{ id: 85_950_393, name: "Springfield", placetype: "locality", country: "US", lat: 42.1, lon: -72.59, score: 0.9 },
	{ id: 85_940_195, name: "Springfield", placetype: "locality", country: "US", lat: 39.8, lon: -89.64, score: 0.8 },
]

function node(tag: AddressNode["tag"], value: string, start: number, end: number): AddressNode {
	return { tag, value, start, end, confidence: 0.9, children: [] }
}

/**
 * A pipeline whose parse reads "Springfield" as a locality, as the classifier does.
 */
const pipeline: ReleasePipeline = {
	version: "10.8.0",
	parse: async (input): Promise<AddressTree> => ({ raw: input, roots: [node("locality", "Springfield", 0, 11)] }),
}

/**
 * A lookup over the three Springfields that keeps the nearest first when a bias point is given.
 */
function springfieldLookup() {
	const findPlace = vi.fn(async (query: LookupQuery) => {
		if (query.text.toLowerCase() !== "springfield") return []

		const [bias] = query.bias ?? []

		if (!bias) return SPRINGFIELDS

		const distance = (place: (typeof SPRINGFIELDS)[number]) => Math.hypot(place.lat - bias.lat, place.lon - bias.lon)

		return SPRINGFIELDS.toSorted((a, b) => distance(a) - distance(b))
	})

	return { findPlace }
}

describe("createEngineWorkerEngine", () => {
	test("parse answers the pipeline's tree and its components", async () => {
		const engine = createEngineWorkerEngine({ pipeline: async () => pipeline, lookup: springfieldLookup() })

		const response = await engine.parse!("Springfield", { inputMode: "auto", debug: false })

		expect(response.components).toEqual([{ tag: "locality", value: "Springfield" }])
		expect(response.tree.raw).toBe("Springfield")
		expect(response.debug).toBeNull()
	})

	test("geocode resolves the parsed locality through the lookup and projects the serve engine's result", async () => {
		const lookup = springfieldLookup()
		const engine = createEngineWorkerEngine({ pipeline: async () => pipeline, lookup })

		const response = await engine.geocode!("Springfield", { inputMode: "auto", bias: [], includeTree: false })

		expect(lookup.findPlace).toHaveBeenCalled()
		expect(response).toMatchObject({ input: "Springfield", locality: "Springfield", lat: 37.21, lon: -93.29 })
		expect(response.tree).toBeNull()
	})

	test("geocode passes the request's bias to the lookup and returns the tree on request", async () => {
		const lookup = springfieldLookup()
		const engine = createEngineWorkerEngine({ pipeline: async () => pipeline, lookup })

		const response = await engine.geocode!("Springfield", {
			inputMode: "auto",
			bias: [{ lat: 39.8, lon: -89.6, weight: 1 }],
			includeTree: true,
		})

		expect(lookup.findPlace.mock.calls.some(([query]) => query.bias?.[0]?.lat === 39.8)).toBe(true)
		expect(response).toMatchObject({ lat: 39.8, lon: -89.64 })
		expect(response.tree?.raw).toBe("Springfield")
	})

	test("createMailwomanAPI serves /v1/geocode from the engine", async () => {
		const engine = createEngineWorkerEngine({ pipeline: async () => pipeline, lookup: springfieldLookup() })
		const app = createMailwomanAPI(engine)

		const response = await app.request("/v1/geocode", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: stringifyJSON({ address: "Springfield" }),
		})

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toMatchObject({ locality: "Springfield", lat: 37.21 })
	})
})
