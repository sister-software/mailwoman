/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the parser-level proposal pipeline.
 *
 *   `writeProposalsToContext` and AddressParser integration are out of scope here — they need a real
 *   `TokenContext`, which triggers the libpostal module-init cascade that the broader core test
 *   infra doesn't yet handle in source mode. Tracked as follow-up work.
 *
 *   The pieces tested here (collectProposals, filterByPolicy, componentTagToLegacyClassification) are
 *   pure and self-contained; they're the ones most likely to subtly break a future iteration.
 */

import {
	collectProposals,
	filterByPolicy,
	type WritebackResult,
	writeProposalsToContext,
} from "@mailwoman/core/parser/proposal-pipeline"
import { InMemoryPolicyRegistry } from "@mailwoman/core/policy"
import type { ClassificationProposal, ComponentTag, ProposalClassifier, Section } from "@mailwoman/core/types"
import { componentTagToLegacyClassification, legacyClassificationToComponentTag } from "@mailwoman/core/types"
import { describe, expect, test } from "vitest"

/** Minimal duck-typed Section — see proposal-classifier.ts for why we don't construct real Spans. */
function makeSection(body: string, start = 0): Section {
	return { body, start, end: start + body.length } as unknown as Section
}

function makeProposal(
	component: ComponentTag,
	source: ClassificationProposal["source"],
	overrides: Partial<ClassificationProposal> = {}
): ClassificationProposal {
	return {
		span: { start: 0, end: 5, body: "test" } as unknown as ClassificationProposal["span"],
		component,
		confidence: 1,
		source,
		source_id: `${source}-test`,
		penalty: 0,
		...overrides,
	}
}

/** A minimal stub ProposalClassifier that returns a canned proposal list. */
function stubClassifier(id: string, emitFor: (section: Section) => ClassificationProposal[]): ProposalClassifier {
	return {
		id,
		emits: ["locality", "postcode", "country", "region"] as readonly ComponentTag[],
		locales: ["*"],
		classify: async (section) => emitFor(section),
	}
}

describe("componentTagToLegacyClassification — inverse mapping", () => {
	test("round-trips every legacy tag that has a component mapping", () => {
		const tags: ComponentTag[] = ["country", "region", "locality", "postcode", "house_number", "street", "venue"]

		for (const tag of tags) {
			const legacy = componentTagToLegacyClassification(tag)
			expect(legacy, `expected an inverse for ${tag}`).not.toBeNull()
			expect(legacyClassificationToComponentTag(legacy!)).toBe(tag)
		}
	})

	test("returns null for components with no legacy equivalent", () => {
		// JP-specific tags don't appear in LEGACY_TO_COMPONENT.
		expect(componentTagToLegacyClassification("prefecture")).toBeNull()
		expect(componentTagToLegacyClassification("building_number")).toBeNull()
	})

	test("dependent_locality maps back to the legacy `dependency` alias", () => {
		expect(componentTagToLegacyClassification("dependent_locality")).toBe("dependency")
	})
})

describe("collectProposals — per-section fan-out", () => {
	test("calls every classifier on every section and concatenates results", async () => {
		const sections = [makeSection("Paris"), makeSection("75004", 6)]
		const cls1 = stubClassifier("a", (s) => [makeProposal("locality", "neural", { source_id: `a:${s.body}` })])
		const cls2 = stubClassifier("b", (s) => [makeProposal("postcode", "rule", { source_id: `b:${s.body}` })])
		const proposals = await collectProposals(sections, [cls1, cls2])
		expect(proposals).toHaveLength(4)
		expect(proposals.map((p) => p.source_id).sort()).toEqual(["a:75004", "a:Paris", "b:75004", "b:Paris"])
	})

	test("classifiers that throw are isolated — others still produce", async () => {
		const sections = [makeSection("Paris")]
		const bad = stubClassifier("bad", () => {
			throw new Error("boom")
		})
		const good = stubClassifier("good", () => [makeProposal("locality", "neural")])
		const proposals = await collectProposals(sections, [bad, good])
		expect(proposals).toHaveLength(1)
		expect(proposals[0]!.source_id).toBe("neural-test")
	})

	test("empty classifier list returns empty proposals", async () => {
		const proposals = await collectProposals([makeSection("Paris")], [])
		expect(proposals).toEqual([])
	})

	test("empty sections list returns empty proposals even with classifiers", async () => {
		const cls = stubClassifier("a", () => [makeProposal("locality", "neural")])
		const proposals = await collectProposals([], [cls])
		expect(proposals).toEqual([])
	})
})

describe("filterByPolicy — policy passthrough", () => {
	const proposals: ClassificationProposal[] = [
		makeProposal("country", "rule", { confidence: 0.9 }),
		makeProposal("country", "neural", { confidence: 0.8 }),
		makeProposal("postcode", "rule", { confidence: 0.7 }),
		makeProposal("postcode", "neural", { confidence: 0.95 }),
	]

	test("returns input unchanged when policy is undefined", () => {
		const filtered = filterByPolicy(proposals, undefined, "en-us")
		expect(filtered).toHaveLength(4)
	})

	test("rule_only default drops neural proposals", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		const filtered = filterByPolicy(proposals, registry, "en-us")
		expect(filtered).toHaveLength(2)

		for (const p of filtered) expect(p.source).toBe("rule")
	})

	test("per-component neural_only keeps only neural for that component, defaults for others", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "postcode", mode: "neural_only" })
		const filtered = filterByPolicy(proposals, registry, "en-us")
		// country still rule_only, postcode now neural_only.
		expect(filtered).toHaveLength(2)
		const byComponent = new Map(filtered.map((p) => [p.component, p]))
		expect(byComponent.get("country")?.source).toBe("rule")
		expect(byComponent.get("postcode")?.source).toBe("neural")
	})

	test("neural_preferred keeps both when neural exists, falls back to rule when not", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "postcode", mode: "neural_preferred" })
		registry.set({ component: "country", mode: "neural_preferred" })
		const ruleOnlyPostcode = [makeProposal("postcode", "rule", { confidence: 0.7 })]
		// Country has both; should drop rule. Postcode has only rule; should keep it.
		const filtered = filterByPolicy(
			[...proposals.filter((p) => p.component === "country"), ...ruleOnlyPostcode],
			registry,
			"en-us"
		)
		const sources = new Map<ComponentTag, Set<string>>()

		for (const p of filtered) {
			const set = sources.get(p.component) ?? new Set()
			set.add(p.source)
			sources.set(p.component, set)
		}
		expect(sources.get("country")).toEqual(new Set(["neural"]))
		expect(sources.get("postcode")).toEqual(new Set(["rule"]))
	})
})

describe("writeProposalsToContext — summary type sanity", () => {
	// Real writeback needs a TokenContext (blocked on libpostal init in source mode). Here we just
	// confirm the exported summary shape so consumers can rely on it.
	test("WritebackResult fields are typed as numbers", () => {
		const result: WritebackResult = { written: 1, skippedNoLegacyMap: 0, skippedNoSpan: 0 }
		expect(typeof result.written).toBe("number")
		expect(typeof result.skippedNoLegacyMap).toBe("number")
		expect(typeof result.skippedNoSpan).toBe("number")
	})

	test("writeProposalsToContext export is callable (smoke)", () => {
		expect(typeof writeProposalsToContext).toBe("function")
	})
})
