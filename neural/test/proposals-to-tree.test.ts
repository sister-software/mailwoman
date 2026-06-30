/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for proposalsToTree — the helper that projects a flat ClassificationProposal[] back into a
 *   flat AddressTree so the existing JSON/tuple/XML decoders can format policy-filtered output.
 */

import { decodeAsJSON, decodeAsTuples, proposalsToTree } from "@mailwoman/core/decoder"
import type { ClassificationProposal, ComponentTag } from "@mailwoman/core/types"
import { describe, expect, test } from "vitest"

function makeProposal(component: ComponentTag, body: string, start: number, confidence = 0.9): ClassificationProposal {
	return {
		span: { start, end: start + body.length, body } as unknown as ClassificationProposal["span"],
		component,
		confidence,
		source: "neural",
		source_id: "neural-test",
		penalty: 0,
	}
}

describe("proposalsToTree", () => {
	test("flat-emits one root per proposal", () => {
		const tree = proposalsToTree("Paris 75004 France", [
			makeProposal("locality", "Paris", 0),
			makeProposal("postcode", "75004", 6),
			makeProposal("country", "France", 12),
		])
		expect(tree.roots).toHaveLength(3)
		expect(tree.roots.every((r) => r.children.length === 0)).toBe(true)
	})

	test("sorts roots by start offset", () => {
		const tree = proposalsToTree("Paris 75004 France", [
			makeProposal("country", "France", 12),
			makeProposal("locality", "Paris", 0),
			makeProposal("postcode", "75004", 6),
		])
		expect(tree.roots.map((r) => r.tag)).toEqual(["locality", "postcode", "country"])
	})

	test("preserves raw input on the tree", () => {
		const tree = proposalsToTree("Paris 75004 France", [])
		expect(tree.raw).toBe("Paris 75004 France")
		expect(tree.roots).toEqual([])
	})

	test("propagates per-proposal confidence to the node", () => {
		const tree = proposalsToTree("Paris", [makeProposal("locality", "Paris", 0, 0.42)])
		expect(tree.roots[0]!.confidence).toBeCloseTo(0.42, 5)
	})

	test("plays nicely with existing JSON decoder", () => {
		const tree = proposalsToTree("Paris 75004", [
			makeProposal("locality", "Paris", 0),
			makeProposal("postcode", "75004", 6),
		])
		expect(decodeAsJSON(tree)).toEqual({ locality: "Paris", postcode: "75004" })
	})

	test("plays nicely with existing tuple decoder (source-ordered)", () => {
		const tree = proposalsToTree("Paris 75004", [
			makeProposal("postcode", "75004", 6),
			makeProposal("locality", "Paris", 0),
		])
		expect(decodeAsTuples(tree)).toEqual([
			["locality", "Paris"],
			["postcode", "75004"],
		])
	})
})
