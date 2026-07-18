/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { runPipeline } from "./runtime-pipeline.ts"
import type { POIIntentOutcome, QueryKindResult } from "./types.ts"

const POI_KIND: QueryKindResult = { kind: "poi_query", confidence: 0.92, alternatives: [] }

describe("poi_query pipeline branch", () => {
	it("routes to stages.poiIntent and returns path 'poi' with the outcome", async () => {
		const outcome: POIIntentOutcome = {
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "hospital", matched: "hospital" } },
		}
		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => outcome,
		})

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual(outcome)
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
		const outcome: POIIntentOutcome = {
			type: "intent",
			intent: {
				subject: { kind: "category", categoryID: "hospital", matched: "hospital" },
				anchor: { text: "Springfield IL", tree: anchorTree },
			},
		}
		const result = await runPipeline("hospital near Springfield IL", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => outcome,
		})

		expect(result.tree).toEqual(anchorTree)
	})

	it("falls through to the full pipeline when the stage returns null", async () => {
		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => null,
		})

		expect(result.path).toBe("full")
		expect(result.poiIntent).toBeUndefined()
		expect("poiIntent" in result).toBe(false)
	})

	it("ignores a poi_query kind entirely when no stage is wired", async () => {
		const result = await runPipeline("hospital", {
			classifyKind: async () => POI_KIND,
		})

		expect(result.path).toBe("full")
		expect("poiIntent" in result).toBe(false)
	})

	it("returns an abstain outcome verbatim", async () => {
		const outcome: POIIntentOutcome = { type: "abstain", reason: "no_executor" }
		const result = await runPipeline("drinking fountain", {
			classifyKind: async () => POI_KIND,
			poiIntent: async () => outcome,
		})

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual(outcome)
	})
})
