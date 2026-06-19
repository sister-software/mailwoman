/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #478 inc 3 fix-v1: containment-preserving arbitration. Verifies the edit rules (relabel same-span
 *   tag disagreements, add rule-only non-overlapping missing tags) and — the load-bearing case —
 *   that neural's street decomposition survives a coarser rule street (the leg-2 precondition
 *   bug).
 */

import { Span } from "@mailwoman/core/tokenization"
import type { ClassificationProposal, ComponentTag } from "@mailwoman/core/types"
import { describe, expect, it } from "vitest"
import { applyRuleArbitration } from "./arbitrate-tree.js"
import type { AddressNode, AddressTree } from "./types.js"

function rp(component: ComponentTag, body: string, start: number, confidence = 1): ClassificationProposal {
	return {
		span: new Span(body, start),
		component,
		confidence,
		source: "rule",
		source_id: "v0",
		penalty: 0,
	} as ClassificationProposal
}
function node(tag: ComponentTag, value: string, start: number, end: number, children: AddressNode[] = []): AddressNode {
	return { tag, value, start, end, confidence: 0.9, children, source: "neural" }
}
function tree(...roots: AddressNode[]): AddressTree {
	return { raw: "x", roots }
}

describe("applyRuleArbitration — relabel (same span, different tag)", () => {
	it("relabels a neural node toward the rule's tag", () => {
		const out = applyRuleArbitration(tree(node("locality", "NYC", 0, 3)), [rp("region", "NYC", 0)])
		expect(out.roots).toHaveLength(1)
		expect(out.roots[0]).toMatchObject({ tag: "region", source: "rule", value: "NYC" })
	})

	it("leaves a same-span same-tag node untouched", () => {
		const out = applyRuleArbitration(tree(node("region", "NYC", 0, 3)), [rp("region", "NYC", 0)])
		expect(out.roots[0]).toMatchObject({ tag: "region", source: "neural" })
	})

	it("relabels nested children too (walks the whole tree)", () => {
		const out = applyRuleArbitration(tree(node("venue", "Foo", 0, 3, [node("locality", "Bar", 5, 8)])), [
			rp("region", "Bar", 5),
		])
		expect(out.roots[0]!.children[0]).toMatchObject({ tag: "region", source: "rule" })
	})
})

describe("applyRuleArbitration — preserves neural structure (the precondition fix)", () => {
	it("keeps neural street + street_suffix; ignores the coarser rule street that subsumes them", () => {
		const out = applyRuleArbitration(tree(node("street", "Seminary", 4, 12), node("street_suffix", "Dr", 13, 15)), [
			rp("street", "Seminary Dr", 4, 0.82),
		])
		const tags = out.roots.map((r) => r.tag)
		expect(tags).toContain("street")
		expect(tags).toContain("street_suffix") // not evicted
		expect(out.roots.find((r) => r.tag === "street")).toMatchObject({ value: "Seminary", start: 4, end: 12 })
		expect(out.roots).toHaveLength(2) // no coarse rule street added
	})

	it("a fully-agreeing parse is a no-op", () => {
		const original = tree(node("locality", "Paris", 0, 5), node("region", "TX", 7, 9))
		const out = applyRuleArbitration(original, [rp("locality", "Paris", 0), rp("region", "TX", 7)])
		expect(out.roots.map((r) => ({ tag: r.tag, value: r.value, source: r.source }))).toEqual([
			{ tag: "locality", value: "Paris", source: "neural" },
			{ tag: "region", value: "TX", source: "neural" },
		])
	})
})

describe("applyRuleArbitration — add rule-only missing tags", () => {
	it("adds a rule tag absent from neural on a non-overlapping span", () => {
		const out = applyRuleArbitration(tree(node("street", "Main", 0, 4)), [rp("country", "USA", 10)])
		const country = out.roots.find((r) => r.tag === "country")
		expect(country).toMatchObject({ value: "USA", source: "rule", start: 10, end: 13 })
	})

	it("does NOT add a rule tag whose span overlaps a neural node", () => {
		const out = applyRuleArbitration(tree(node("street", "Main", 0, 4)), [rp("country", "Mai", 0)])
		expect(out.roots).toHaveLength(1)
		expect(out.roots[0]!.tag).toBe("street")
	})

	it("adds a rule-only tag at most once and keeps roots in span order", () => {
		const out = applyRuleArbitration(tree(node("street", "Main", 4, 8)), [
			rp("house_number", "12", 0),
			rp("house_number", "12", 0),
		])
		expect(out.roots.map((r) => r.tag)).toEqual(["house_number", "street"])
	})
})
