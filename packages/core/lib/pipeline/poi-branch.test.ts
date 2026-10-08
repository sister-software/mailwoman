/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { runPipeline } from "#pipeline/runtime-pipeline"
import type { POIQueryResult, QueryKindResult } from "#pipeline/types"

const POI_KIND: QueryKindResult = { kind: "poi_query", confidence: 0.92, alternatives: [], intentMarkers: null }

describe("poi_query pipeline branch", () => {
	it("routes to stages.poiIntent and returns path 'poi' with the result", async () => {
		const poiResult: POIQueryResult = {
			type: "intent",
			intent: {
				subject: { kind: "category", categoryIDs: ["hospital"], matched: "hospital", countryBinding: null },
				relation: null,
				anchor: null,
				limit: null,
			},
			results: null,
		}

		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => poiResult,
		})

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual(poiResult)
		expect(result.kind.kind).toBe("poi_query")
		expect(result.tree.roots).toEqual([])
		expect(result.timing["poi-intent"]).toBeTypeOf("number")
	})

	it("carries the anchor tree into result.tree when the intent has one", async () => {
		const anchorTree = {
			raw: "Springfield IL",
			roots: [
				{
					tag: "locality" as const,
					value: "Springfield",
					start: 0,
					end: 11,
					confidence: 0.9,
					children: [],
				},
			],
		}

		const poiResult: POIQueryResult = {
			type: "intent",
			intent: {
				subject: { kind: "category", categoryIDs: ["hospital"], matched: "hospital", countryBinding: null },
				anchor: { text: "Springfield IL", tree: anchorTree, biasPoint: null, radiusM: null },
				relation: null,
				limit: null,
			},
			results: null,
		}

		const result = await runPipeline("hospital near Springfield IL", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => poiResult,
		})

		expect(result.tree).toEqual(anchorTree)
	})

	it("falls through to the full pipeline when the stage returns null", async () => {
		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => null,
		})

		expect(result.path).toBe("full")
		expect(result.poiIntent).toBeNull()
		expect(result.poiIntent).toBeNull()
	})

	it("ignores a poi_query kind entirely when no stage is wired", async () => {
		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
		})

		expect(result.path).toBe("full")
		expect(result.poiIntent).toBeNull()
	})

	it("returns an abstain result verbatim", async () => {
		const poiResult: POIQueryResult = { type: "abstain", reason: "no_executor" }

		const result = await runPipeline("drinking fountain", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => poiResult,
		})

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual(poiResult)
	})
})
