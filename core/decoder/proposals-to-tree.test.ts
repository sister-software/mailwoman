/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `treeToProposals` (#478 inc 3) — the inverse of `proposalsToTree`, used to bring the whole-text
 *   neural parse into the arbitration layer's proposal currency.
 */

import { describe, expect, it } from "vitest"
import type { ComponentTag } from "../types/index.js"
import { proposalsToTree, treeToProposals } from "./proposals-to-tree.js"
import type { AddressTree } from "./types.js"

describe("treeToProposals", () => {
	it("walks nodes depth-first (incl. children) into proposals with the given source/sourceId", () => {
		const tree: AddressTree = {
			raw: "x",
			roots: [
				{
					tag: "street",
					value: "Main",
					start: 0,
					end: 4,
					confidence: 0.9,
					children: [{ tag: "house_number", value: "350", start: 5, end: 8, confidence: 0.8, children: [] }],
				},
			],
		}
		const props = treeToProposals(tree, "neural", { sourceId: "n1" })
		expect(props.map((p) => p.component)).toEqual(["street", "house_number"])
		expect(props.every((p) => p.source === "neural" && p.source_id === "n1")).toBe(true)
		expect(props[1]).toMatchObject({ confidence: 0.8 })
		expect(props[1]!.span.start).toBe(5)
		expect(props[1]!.span.end).toBe(8)
	})

	it("emits filter restricts which tags become proposals", () => {
		const tree: AddressTree = {
			raw: "x",
			roots: [
				{ tag: "street", value: "Main", start: 0, end: 4, confidence: 0.9, children: [] },
				{ tag: "locality", value: "NYC", start: 5, end: 8, confidence: 0.9, children: [] },
			],
		}
		const props = treeToProposals(tree, "neural", { emits: new Set<ComponentTag>(["street"]) })
		expect(props.map((p) => p.component)).toEqual(["street"])
	})

	it("round-trips through proposalsToTree preserving tag/value/span (flat)", () => {
		const tree: AddressTree = {
			raw: "350 Main",
			roots: [
				{ tag: "house_number", value: "350", start: 0, end: 3, confidence: 0.9, children: [] },
				{ tag: "street", value: "Main", start: 4, end: 8, confidence: 0.9, children: [] },
			],
		}
		const project = (t: AddressTree) =>
			t.roots.map((r) => ({ tag: r.tag, value: r.value, start: r.start, end: r.end }))
		const rebuilt = proposalsToTree(tree.raw, treeToProposals(tree, "neural"))
		expect(project(rebuilt)).toEqual(project(tree))
	})
})
