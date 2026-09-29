/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { InMemoryPolicyRegistry } from "#policy/registry"
import { Span } from "#tokenization"
import type { ClassificationProposal } from "#types"

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
	test("returns neural_only when registry is empty", () => {
		const registry = new InMemoryPolicyRegistry()
		const p = registry.lookup("country")
		expect(p).toEqual({ component: "country", mode: "neural_only" })
	})

	test("withDefaults pre-loads neural_only for every tag", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		expect(registry.lookup("country").mode).toBe("neural_only")
		expect(registry.lookup("street").mode).toBe("neural_only")
		expect(registry.lookup("venue").mode).toBe("neural_only")
	})

	test("locale-specific entry wins over global entry", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "postcode", mode: "both" })
		registry.set({ component: "postcode", mode: "neural_only", locale: "en-US" })

		expect(registry.lookup("postcode").mode).toBe("both")
		expect(registry.lookup("postcode", "en-US").mode).toBe("neural_only")
		expect(registry.lookup("postcode", "fr-FR").mode).toBe("both")
	})

	test("remove restores the implicit neural_only default", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "country", mode: "both" })
		registry.remove("country")
		expect(registry.lookup("country").mode).toBe("neural_only")
	})
})

describe("InMemoryPolicyRegistry — apply by mode", () => {
	const proposals: ClassificationProposal[] = [
		makeProposal({ component: "country", source: "neural", confidence: 0.8 }),
		makeProposal({ component: "country", source: "merged", confidence: 0.85 }),
	]

	test("neural_only keeps only neural proposals", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source)).toEqual(["neural"])
	})

	test("both keeps every proposal", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "country", mode: "both" })
		const out = registry.apply(proposals)
		expect(out.map((p) => p.source).toSorted()).toEqual(["merged", "neural"])
	})
})

describe("InMemoryPolicyRegistry — confidence threshold", () => {
	test("drops proposals below the configured threshold", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "postcode", mode: "both", confidence_threshold: 0.5 })

		const proposals: ClassificationProposal[] = [
			makeProposal({ component: "postcode", source: "neural", confidence: 0.3 }),
			makeProposal({ component: "postcode", source: "neural", confidence: 0.7 }),
			makeProposal({ component: "postcode", source: "merged", confidence: 0.5 }),
		]

		const out = registry.apply(proposals)
		expect(out.map((p) => p.confidence)).toEqual([0.7, 0.5])
	})

	test("threshold is inclusive at the boundary", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		registry.set({ component: "region", mode: "neural_only", confidence_threshold: 0.4 })

		const out = registry.apply([
			makeProposal({ component: "region", source: "neural", confidence: 0.4 }),
			makeProposal({ component: "region", source: "neural", confidence: 0.39 }),
		])

		expect(out.map((p) => p.confidence)).toEqual([0.4])
	})
})

describe("InMemoryPolicyRegistry — pass-through behavior", () => {
	test("proposals for components with no override fall under the default neural_only", () => {
		const registry = new InMemoryPolicyRegistry()

		const out = registry.apply([
			makeProposal({ component: "locality", source: "neural" }),
			makeProposal({ component: "locality", source: "merged" }),
		])

		expect(out.map((p) => p.source)).toEqual(["neural"])
	})

	test("input array is not mutated", () => {
		const registry = InMemoryPolicyRegistry.withDefaults()
		const input = [makeProposal({ component: "country", source: "merged" })]
		const out = registry.apply(input)
		expect(input).toHaveLength(1)
		expect(out).toHaveLength(0)
	})
})
