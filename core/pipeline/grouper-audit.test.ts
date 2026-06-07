/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "@mailwoman/core/tokenization"
import { describe, expect, it } from "vitest"
import type { AddressTree } from "../decoder/types.js"
import type { ClassifierCandidate } from "./reconcile.js"
import { grouperAudit, runPipeline } from "./runtime-pipeline.js"
import type { PhraseProposal, RuntimePipelineStages } from "./types.js"

function makeStages(overrides: Partial<RuntimePipelineStages> = {}): RuntimePipelineStages {
	return {
		normalize: (raw) => ({ normalized: raw, originalToNormalized: (i: number) => i }),
		computeQueryShape: (input) => ({
			knownFormats: [],
			segments: [{ body: input.normalized, span: { start: 0, end: input.normalized.length } }],
		}),
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
		expect(localities.length).toBe(1)
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
		expect(auditNodes.length).toBe(0)
		expect(result.tree.roots.length).toBe(1)
		expect(result.tree.roots[0]!.tag).toBe("region")
	})

	// #425 — when the joint-reconcile path leaves a span orphaned but the classifier confidently typed
	// it, the audit must defer to the classifier's verdict instead of the structural phrase kind.
	describe("classifier-deferral on orphaned spans (joint path)", () => {
		// "Via Trento 24, SORBOLO": reconcile keeps locality=SORBOLO and leaves "Via" orphaned. The
		// LOCALITY_PHRASE proposal for "Via" would inject a spurious locality without the deferral.
		const tree: AddressTree = {
			raw: "Via Trento, SORBOLO",
			roots: [{ tag: "locality", value: "SORBOLO", start: 12, end: 19, confidence: 0.9, children: [] }],
		}
		const proposals = [
			{ span: Span.from("Via", { start: 0 }), kindHypothesis: "LOCALITY_PHRASE", confidence: 0.55 },
		] as PhraseProposal[]

		it("injects the classifier's tag (street) for an orphaned LOCALITY_PHRASE span", () => {
			const classifierTopK: ClassifierCandidate[] = [{ span: { start: 0, end: 3 }, tag: "street", score: 0.73 }]
			const out = grouperAudit(tree, proposals, tree.raw, classifierTopK)
			const via = out.roots.find((n) => n.value === "Via")
			expect(via).toBeDefined()
			expect(via!.tag).toBe("street") // classifier verdict, NOT the LOCALITY_PHRASE structural kind
			// The real city is preserved and is the only locality.
			expect(out.roots.filter((n) => n.tag === "locality").map((n) => n.value)).toEqual(["SORBOLO"])
		})

		it("falls back to the phrase kind when the classifier verdict is weak (<0.4)", () => {
			const classifierTopK: ClassifierCandidate[] = [{ span: { start: 0, end: 3 }, tag: "street", score: 0.2 }]
			const out = grouperAudit(tree, proposals, tree.raw, classifierTopK)
			expect(out.roots.find((n) => n.value === "Via")!.tag).toBe("locality")
		})

		it("falls back to the phrase kind when no classifierTopK is supplied (argmax path)", () => {
			const out = grouperAudit(tree, proposals, tree.raw)
			expect(out.roots.find((n) => n.value === "Via")!.tag).toBe("locality")
		})
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
		expect(result.tree.roots.length).toBe(0)
	})
})
