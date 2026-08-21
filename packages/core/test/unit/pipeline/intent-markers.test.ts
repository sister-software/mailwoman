/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The coordinator's half of the ROAD_TO_V9 §4 contract: `intentMarkers` is ALWAYS an array on
 *   every return path, and the coordinator lifts rather than invents — it never adds a marker the
 *   classifier did not raise, and it never drops one it did.
 */

import { runPipeline } from "@mailwoman/core/pipeline/runtime-pipeline"
import type {
	AddressClassifier,
	LocaleHint,
	NormalizedInputLite,
	POIIntentOutcome,
	QueryIntentMarker,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
} from "@mailwoman/core/pipeline/types"
import { describe, expect, test } from "vitest"

const FORK: QueryIntentMarker = {
	kind: "route_pair",
	code: "declared_fork",
	mechanism: "kind:route_pair",
	message: "two readings",
	evidence: { tokens: ["Paris", "London"] },
}

function classifierStub(): AddressClassifier {
	return { parse: async (text) => ({ raw: text, roots: [] }) }
}

function kindStage(verdict: QueryKindResult) {
	return async (_i: NormalizedInputLite, _s: QueryShapeLite, _l: LocaleHint): Promise<QueryKindResult> => verdict
}

describe("PipelineResult.intentMarkers", () => {
	test("is an empty array — not absent — when the classifier has no intent vocabulary", async () => {
		const result = await runPipeline("350 5th Ave, New York, NY 10118", { classifier: classifierStub() })

		expect(result.intentMarkers).toEqual([])
		expect("intentMarkers" in result).toBe(true)
	})

	test("lifts the classifier's markers onto the full path", async () => {
		const stages: RuntimePipelineStages = {
			classifier: classifierStub(),
			classifyKind: kindStage({
				kind: "locality_only",
				confidence: 0.85,
				alternatives: [{ kind: "route_pair", confidence: 0.55 }],
				intentMarkers: [FORK],
			}),
		}

		const result = await runPipeline("Paris London", stages)

		expect(result.path).toBe("full")
		expect(result.intentMarkers).toEqual([FORK])
	})

	test("survives the fast path, which returns before the classifier ever runs", async () => {
		const stages: RuntimePipelineStages = {
			computeQueryShape: () => ({ knownFormats: [], characterClass: "alpha", totalLength: 5 }),
			classifyKind: kindStage({
				kind: "locality_only",
				confidence: 0.99,
				alternatives: [{ kind: "bare_toponym", confidence: 0.84 }],
				intentMarkers: [FORK],
			}),
		}

		const result = await runPipeline("Paris", stages)

		expect(result.path).toBe("fast-path")
		expect(result.intentMarkers).toEqual([FORK])
	})

	test("survives the POI branch", async () => {
		const outcome: POIIntentOutcome = { type: "abstain", reason: "no executor" }

		const stages: RuntimePipelineStages = {
			classifier: classifierStub(),
			classifyKind: kindStage({ kind: "poi_query", confidence: 0.92, alternatives: [], intentMarkers: [FORK] }),
			poiIntent: async () => outcome,
		}

		const result = await runPipeline("hospital", stages)

		expect(result.path).toBe("poi")
		expect(result.intentMarkers).toEqual([FORK])
	})

	test("copies rather than aliases — a caller mutating the result cannot reach back into the verdict", async () => {
		const verdict: QueryKindResult = {
			kind: "locality_only",
			confidence: 0.85,
			alternatives: [],
			intentMarkers: [FORK],
		}

		const result = await runPipeline("Paris London", { classifier: classifierStub(), classifyKind: kindStage(verdict) })

		result.intentMarkers.push({ ...FORK, code: "focus_point_required" })

		expect(verdict.intentMarkers).toHaveLength(1)
	})
})

describe("the POI branch accepts poi_category", () => {
	test("a bare category takes the same branch poi_query does", async () => {
		const outcome: POIIntentOutcome = { type: "abstain", reason: "resolution out of scope" }

		const stages: RuntimePipelineStages = {
			classifier: classifierStub(),
			classifyKind: kindStage({ kind: "poi_category", confidence: 0.93, alternatives: [] }),
			poiIntent: async () => outcome,
		}

		const result = await runPipeline("tacos", stages)

		expect(result.path).toBe("poi")
		expect(result.poiIntent).toEqual(outcome)
	})

	test("and still falls through to the full pipeline on a null outcome, exactly as poi_query does", async () => {
		const stages: RuntimePipelineStages = {
			classifier: classifierStub(),
			classifyKind: kindStage({ kind: "poi_category", confidence: 0.93, alternatives: [] }),
			poiIntent: async () => null,
		}

		expect((await runPipeline("tacos", stages)).path).toBe("full")
	})
})
