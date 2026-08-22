/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressTree } from "@mailwoman/core/decoder/types"
import { grouperAudit, runPipeline } from "@mailwoman/core/pipeline/runtime-pipeline"
import type { PhraseProposal, RuntimePipelineStages } from "@mailwoman/core/pipeline/types"
import { describe, expect, it } from "vitest"

import { Span } from "#tokenization"

function makeStages(overrides: Partial<RuntimePipelineStages> = {}): RuntimePipelineStages {
	return {
		normalize: (raw) => ({ raw, normalized: raw }),
		computeQueryShape: (input) => {
			// The stage contract accepts a bare string as well as a normalized input.
			const normalized = typeof input === "string" ? input : input.normalized

			return {
				knownFormats: [],
				segments: [{ body: normalized, index: 0 }],
			}
		},
		...overrides,
	}
}

describe("grouper-audit pass", () => {
	it("injects provisional venue node when classifier produces empty tree", async () => {
		const stages = makeStages({
			groupPhrases: async () => {
				return [
					{
						span: Span.from("Buffalo Health Clinic", { start: 0 }),
						kindHypothesis: "VENUE_PHRASE",
						confidence: 0.85,
					},
					{
						span: Span.from("Buffalo", { start: 23 }),
						kindHypothesis: "LOCALITY_PHRASE",
						confidence: 0.7,
					},
					{
						span: Span.from("NY", { start: 32 }),
						kindHypothesis: "REGION_ABBREVIATION",
						confidence: 0.85,
					},
				] as PhraseProposal[]
			},
			classifier: {
				parse: async (text) => ({ raw: text, roots: [] }),
			},
		})

		const result = await runPipeline("Buffalo Health Clinic, Buffalo, NY", stages, {})

		const venue = result.tree.roots.find((n) => n.tag === "venue")
		expect(venue).toBeDefined()
		expect(venue!.value).toBe("Buffalo Health Clinic")
		expect(venue!.source).toBe("grouper-audit")
		expect(venue!.confidence).toBeCloseTo(0.85 * 0.55, 3)

		const locality = result.tree.roots.find((n) => n.tag === "locality")
		expect(locality).toBeDefined()
		expect(locality!.value).toBe("Buffalo")

		const region = result.tree.roots.find((n) => n.tag === "region")
		expect(region).toBeDefined()
		expect(region!.value).toBe("NY")
	})

	it("does not inject when classifier already covers the span", async () => {
		const stages = makeStages({
			groupPhrases: async () => {
				return [
					{
						span: Span.from("Portland", { start: 0 }),
						kindHypothesis: "LOCALITY_PHRASE",
						confidence: 0.7,
					},
				] as PhraseProposal[]
			},
			classifier: {
				parse: async (text) => ({
					raw: text,
					roots: [
						{
							tag: "locality",
							value: "Portland",
							start: 0,
							end: 8,
							confidence: 0.9,
							children: [],
						},
					],
				}),
			},
		})

		const result = await runPipeline("Portland, OR", stages, {})
		const localities = result.tree.roots.filter((n) => n.tag === "locality")
		expect(localities).toHaveLength(1)
		expect(localities[0]!.source).toBeUndefined()
	})

	it("is a no-op when classifier covers all proposal spans (v0.5.3 pattern)", async () => {
		const stages = makeStages({
			groupPhrases: async () => {
				return [
					{ span: Span.from("400", { start: 0 }), kindHypothesis: "NUMERIC", confidence: 0.9 },
					{ span: Span.from("Broad St", { start: 4 }), kindHypothesis: "STREET_PHRASE", confidence: 0.8 },
					{ span: Span.from("Seattle", { start: 14 }), kindHypothesis: "LOCALITY_PHRASE", confidence: 0.85 },
					{ span: Span.from("WA", { start: 23 }), kindHypothesis: "REGION_ABBREVIATION", confidence: 0.9 },
					{ span: Span.from("98109", { start: 26 }), kindHypothesis: "POSTCODE", confidence: 0.95 },
				] as PhraseProposal[]
			},
			classifier: {
				parse: async (text) => ({
					raw: text,
					roots: [
						{
							tag: "region",
							value: "WA",
							start: 23,
							end: 25,
							confidence: 0.98,
							children: [
								{
									tag: "locality",
									value: "Seattle",
									start: 14,
									end: 21,
									confidence: 0.98,
									children: [
										{
											tag: "street",
											value: "Broad St",
											start: 4,
											end: 12,
											confidence: 0.98,
											children: [
												{ tag: "house_number", value: "400", start: 0, end: 3, confidence: 0.97, children: [] },
											],
										},
										{ tag: "postcode", value: "98109", start: 26, end: 31, confidence: 0.96, children: [] },
									],
								},
							],
						},
					],
				}),
			},
		})

		const result = await runPipeline("400 Broad St, Seattle, WA 98109", stages, {})
		const auditNodes = result.tree.roots.filter((n) => n.source === "grouper-audit")
		expect(auditNodes).toHaveLength(0)
		expect(result.tree.roots).toHaveLength(1)
		expect(result.tree.roots[0]!.tag).toBe("region")
	})

	it("does not inject for unmapped phrase kinds", async () => {
		const stages = makeStages({
			groupPhrases: async () => {
				return [
					{
						span: Span.from("NY-NY", { start: 0 }),
						kindHypothesis: "HYPHENATED_COMPOUND",
						confidence: 0.88,
					},
				] as PhraseProposal[]
			},
			classifier: {
				parse: async (text) => ({ raw: text, roots: [] }),
			},
		})

		const result = await runPipeline("NY-NY", stages, {})
		expect(result.tree.roots).toHaveLength(0)
	})
})
