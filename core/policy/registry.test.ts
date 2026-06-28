/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "@mailwoman/core/tokenization"
import type { ClassificationProposal } from "@mailwoman/core/types"
import { describe, expect, test } from "vitest"

import { InMemoryPolicyRegistry } from "./registry.js"

function makeProposal(
	overrides: Partial<ClassificationProposal> & Pick<ClassificationProposal, "component" | "source">
): ClassificationProposal {
	return {
		span: Span.from("x"),
		confidence: 1,
		source_id: `${overrides.source}-test`,
		penalty: 0,
		...overrides,
	} as ClassificationProposal
}

describe("InMemoryPolicyRegistry — lookup", () => {
	test("returns rule_only when registry is empty", () => {
		const registry = new InMemoryPolicyRegistry()
		const p = registry.lookup("country")
		expect(p).toEqual({ component: "country", mode: "rule_only" })
	})

	test("withDefaults pre-loads rule_only for every tag", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		expect(registry.lookup("country").mode).toBe("rule_only")
		expect(registry.lookup("street").mode).toBe("rule_only")
		expect(registry.lookup("venue").mode).toBe("rule_only")
	})

	test("locale-specific entry wins over global entry", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "postcode", mode: "both" })
		registry.set({ component: "postcode", mode: "neural_only", locale: "en-US" })

		expect(registry.lookup("postcode").mode).toBe("both")
		expect(registry.lookup("postcode", "en-US").mode).toBe("neural_only")
		expect(registry.lookup("postcode", "fr-FR").mode).toBe("both")
	})

	test("remove restores the implicit rule_only default", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "country", mode: "neural_only" })
		registry.remove("country")
		expect(registry.lookup("country").mode).toBe("rule_only")
	})
})

describe("InMemoryPolicyRegistry — apply by mode", () => {
	const proposals: ClassificationProposal[] = [
		makeProposal({ component: "country", source: "rule", confidence: 0.9 }),
		makeProposal({ component: "country", source: "neural", confidence: 0.8 }),
		makeProposal({ component: "country", source: "merged", confidence: 0.85 }),
	]

	test("rule_only keeps only rule proposals", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source)).toEqual(["rule"])
	})

	test("neural_only keeps only neural proposals", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "country", mode: "neural_only" })
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source)).toEqual(["neural"])
	})

	test("both keeps every proposal", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "country", mode: "both" })
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source).sort()).toEqual(["merged", "neural", "rule"])
	})

	test("neural_preferred drops rule when neural is present", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "country", mode: "neural_preferred" })
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source).sort()).toEqual(["merged", "neural"])
	})

	test("neural_preferred falls back to rule when no neural proposal", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "country", mode: "neural_preferred" })
		const only = [
			makeProposal({ component: "country", source: "rule", confidence: 0.9 }),
			makeProposal({ component: "country", source: "merged", confidence: 0.85 }),
		]
		const out = registry.apply(only)
		expect(out.map((p) => p.source).sort()).toEqual(["merged", "rule"])
	})

	test("merged-source proposals survive both preference modes (they are neither rule nor neural)", () => {
		const registry = new InMemoryPolicyRegistry()
		registry.set({ component: "country", mode: "neural_preferred" })
		const proposals = [
			makeProposal({ component: "country", source: "neural", confidence: 0.9 }),
			makeProposal({ component: "country", source: "rule", confidence: 0.9 }),
			makeProposal({ component: "country", source: "merged", confidence: 0.9 }),
		]
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source).sort()).toEqual(["merged", "neural"])
	})

	test("a below-threshold preferred source does NOT trigger dropping the dispreferred one", () => {
		// Threshold runs BEFORE preference: a neural proposal that died at the threshold must not
		// count as "neural present" — else rule proposals vanish with nothing to replace them.
		const registry = new InMemoryPolicyRegistry()
		registry.set({ component: "country", mode: "neural_preferred", confidence_threshold: 0.8 })
		const proposals = [
			makeProposal({ component: "country", source: "neural", confidence: 0.5 }),
			makeProposal({ component: "country", source: "rule", confidence: 0.9 }),
		]
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source)).toEqual(["rule"])
	})

	test("rule_preferred drops neural when rule is present", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "country", mode: "rule_preferred" })
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source).sort()).toEqual(["merged", "rule"])
	})
})

describe("InMemoryPolicyRegistry — confidence threshold", () => {
	test("drops proposals below the configured threshold", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "postcode", mode: "both", confidence_threshold: 0.5 })

		const proposals: ClassificationProposal[] = [
			makeProposal({ component: "postcode", source: "rule", confidence: 0.3 }),
			makeProposal({ component: "postcode", source: "rule", confidence: 0.7 }),
			makeProposal({ component: "postcode", source: "neural", confidence: 0.5 }),
		]

		const out = registry.apply(proposals)
		expect(out.map((p) => p.confidence)).toEqual([0.7, 0.5])
	})

	test("threshold is inclusive at the boundary", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "region", mode: "rule_only", confidence_threshold: 0.4 })

		const out = registry.apply([
			makeProposal({ component: "region", source: "rule", confidence: 0.4 }),
			makeProposal({ component: "region", source: "rule", confidence: 0.39 }),
		])
		expect(out.map((p) => p.confidence)).toEqual([0.4])
	})
})

describe("InMemoryPolicyRegistry — pass-through behavior", () => {
	test("proposals for components with no override flow through default rule_only", () => {
		const registry = new InMemoryPolicyRegistry()
		const out = registry.apply([
			makeProposal({ component: "locality", source: "rule" }),
			makeProposal({ component: "locality", source: "neural" }),
		])
		expect(out.map((p) => p.source)).toEqual(["rule"])
	})

	test("input array is not mutated", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		const input = [makeProposal({ component: "country", source: "neural" })]
		const out = registry.apply(input)
		expect(input.length).toBe(1)
		expect(out.length).toBe(0)
	})
})
