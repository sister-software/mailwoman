/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #478 increment 2 acceptance. Three layers:
 *
 *   1. `routeInputShape` — exhaustive coverage of the decision tree (every branch + the precedence
 *        edges: OOD script beats a clean kind; placer abstention beats a clean kind; the 0.8
 *        cutoff).
 *   2. `policyRegistryFromRoute` — the routed prior becomes the table default; explicit config still
 *        wins per-tag.
 *   3. The seam (`filterByPolicy` with `routerPrior`) — the "flag-ON lane": the integration code is
 *        exercised end-to-end even though production ships it default-off (no caller passes a prior
 *        until #478 increment 3). Guards against the "default-off ⇒ never exercised" risk.
 */

import { Span } from "@mailwoman/core/tokenization"
import type { ClassificationProposal } from "@mailwoman/core/types"
import { describe, expect, test } from "vitest"

import { filterByPolicy } from "../parser/proposal-pipeline.js"
import { policyRegistryFromRoute } from "./from-config.js"
import {
	type InputShapeRoute,
	type RouterKindSignal,
	type RouterPlacerSignal,
	type RouterShapeSignal,
	routeInputShape,
} from "./input-shape-router.js"
import { InMemoryPolicyRegistry } from "./registry.js"

function kind(k: string, confidence: number): RouterKindSignal {
	return { kind: k, confidence }
}
function shape(characterClass?: string): RouterShapeSignal {
	return { characterClass }
}
const PLACER_US: RouterPlacerSignal = { country: "US", abstained: false }
const PLACER_ABSTAINED: RouterPlacerSignal = { country: null, abstained: true }
const PLACER_OTHER: RouterPlacerSignal = { country: "OTHER", abstained: false }

describe("routeInputShape — clean structured → rule_preferred", () => {
	test("structured_address, high conf, alpha, confident placer", () => {
		const r = routeInputShape(kind("structured_address", 0.95), shape("alpha"), PLACER_US)
		expect(r.defaultMode).toBe("rule_preferred")
		expect(r.abstain).toBe(false)
		expect(r.reason).toContain("clean:structured_address")
	})

	test.each(["intersection", "po_box", "postcode_only"])("clean kind %s buckets with structured", (k) => {
		expect(routeInputShape(kind(k, 0.85), shape("alphanumeric"), PLACER_US).defaultMode).toBe("rule_preferred")
	})

	test("confidence at the 0.8 boundary is clean (inclusive)", () => {
		expect(routeInputShape(kind("structured_address", 0.8), shape("numeric"), PLACER_US).defaultMode).toBe(
			"rule_preferred"
		)
	})

	test("undefined characterClass counts as Latin (clean)", () => {
		expect(routeInputShape(kind("structured_address", 0.9), shape(undefined), PLACER_US).defaultMode).toBe(
			"rule_preferred"
		)
	})

	test("null placer does not block rule_preferred (no signal ≠ abstention)", () => {
		expect(routeInputShape(kind("structured_address", 0.9), shape("alpha"), null).defaultMode).toBe("rule_preferred")
	})
})

describe("routeInputShape — OOD script → neural_preferred (highest precedence)", () => {
	test.each(["cjk", "cyrillic", "arabic"])("script %s routes neural even for a clean high-conf kind", (cc) => {
		const r = routeInputShape(kind("structured_address", 0.99), shape(cc), PLACER_US)
		expect(r.defaultMode).toBe("neural_preferred")
		expect(r.reason).toContain(`ood-script:${cc}`)
	})

	test("OOD script beats abstention too (script checked first)", () => {
		// low conf + abstained placer would otherwise abstain; OOD wins.
		expect(routeInputShape(kind("structured_address", 0.3), shape("cjk"), PLACER_ABSTAINED).defaultMode).toBe(
			"neural_preferred"
		)
	})
})

describe("routeInputShape — both weak → abstain (mode both)", () => {
	test("clean kind but confidence below 0.8", () => {
		const r = routeInputShape(kind("structured_address", 0.79), shape("alpha"), PLACER_US)
		expect(r.defaultMode).toBe("both")
		expect(r.abstain).toBe(true)
		expect(r.reason).toContain("weak:")
	})

	test("clean high-conf kind but placer abstained", () => {
		const r = routeInputShape(kind("structured_address", 0.95), shape("alpha"), PLACER_ABSTAINED)
		expect(r.defaultMode).toBe("both")
		expect(r.abstain).toBe(true)
	})

	test("clean high-conf kind but placer off-map (OTHER)", () => {
		expect(routeInputShape(kind("structured_address", 0.95), shape("alpha"), PLACER_OTHER).abstain).toBe(true)
	})

	test("low-confidence non-clean kind also abstains", () => {
		expect(routeInputShape(kind("vague", 0.3), shape("alpha"), PLACER_US).abstain).toBe(true)
	})
})

describe("routeInputShape — confident non-clean → neural_preferred", () => {
	test.each(["landmark", "vague", "locality_only"])("kind %s, high conf, Latin, placer OK → neural", (k) => {
		const r = routeInputShape(kind(k, 0.9), shape("alpha"), PLACER_US)
		expect(r.defaultMode).toBe("neural_preferred")
		expect(r.abstain).toBe(false)
		expect(r.reason).toContain("neural-default")
	})

	test("mixed-script clean kind is NOT rule_preferred (mixed ∉ Latin) → neural", () => {
		expect(routeInputShape(kind("structured_address", 0.9), shape("mixed"), PLACER_US).defaultMode).toBe(
			"neural_preferred"
		)
	})
})

describe("policyRegistryFromRoute — routed default + config overlay", () => {
	test("the routed defaultMode becomes every tag's default", () => {
		const route: InputShapeRoute = { defaultMode: "neural_preferred", abstain: false, reason: "x" }
		const registry = policyRegistryFromRoute(route)
		expect(registry.lookup("street").mode).toBe("neural_preferred")
		expect(registry.lookup("postcode", "en-US").mode).toBe("neural_preferred")
	})

	test("explicit per-tag config wins over the routed default", () => {
		const route: InputShapeRoute = { defaultMode: "rule_preferred", abstain: false, reason: "x" }
		const registry = policyRegistryFromRoute(route, { "en-US": { street: { mode: "neural_only" } } })
		expect(registry.lookup("street", "en-US").mode).toBe("neural_only") // config wins
		expect(registry.lookup("region", "en-US").mode).toBe("rule_preferred") // route default fills the rest
	})

	test("abstain route (mode both) defaults every tag to both", () => {
		const route: InputShapeRoute = { defaultMode: "both", abstain: true, reason: "weak" }
		expect(policyRegistryFromRoute(route).lookup("country").mode).toBe("both")
	})
})

// --- The seam / flag-ON lane: filterByPolicy with a routerPrior -----------------------------------

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

describe("filterByPolicy — routerPrior seam (#478 increment 2)", () => {
	const proposals: ClassificationProposal[] = [
		makeProposal({ component: "region", source: "rule", confidence: 0.9 }),
		makeProposal({ component: "region", source: "neural", confidence: 0.8 }),
	]

	test("no policy and no router prior → unchanged (default-off, byte-stable)", () => {
		const out = filterByPolicy(proposals, undefined, "en-US")
		expect(out).toHaveLength(2)
	})

	test("router prior neural_preferred drops the rule proposal", () => {
		const route: InputShapeRoute = { defaultMode: "neural_preferred", abstain: false, reason: "x" }
		const out = filterByPolicy(proposals, undefined, "en-US", route)
		expect(out.map((p) => p.source)).toEqual(["neural"])
	})

	test("router prior rule_preferred drops the neural proposal", () => {
		const route: InputShapeRoute = { defaultMode: "rule_preferred", abstain: false, reason: "x" }
		const out = filterByPolicy(proposals, undefined, "en-US", route)
		expect(out.map((p) => p.source)).toEqual(["rule"])
	})

	test("abstain route (both) keeps every source", () => {
		const route: InputShapeRoute = { defaultMode: "both", abstain: true, reason: "weak" }
		const out = filterByPolicy(proposals, undefined, "en-US", route)
		expect(out).toHaveLength(2)
	})

	test("an explicit policy is authoritative — the router prior is ignored", () => {
		// Explicit registry forces rule_only; even a neural_preferred route must not override it.
		const explicit = InMemoryPolicyRegistry.withDefaults("rule_only")
		const route: InputShapeRoute = { defaultMode: "neural_preferred", abstain: false, reason: "x" }
		const out = filterByPolicy(proposals, explicit, "en-US", route)
		expect(out.map((p) => p.source)).toEqual(["rule"])
	})
})
