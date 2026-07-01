/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase 4.1 — source provenance flowing through the decoder.
 */

import { describe, expect, test } from "vitest"

import { Span } from "../tokenization/Span.js"
import type { BIOLabel } from "../types/component.js"
import type { ClassificationProposal } from "../types/index.js"
import { buildAddressTree } from "./build-tree.js"
import { proposalsToTree } from "./proposals-to-tree.js"
import { decodeAsJSON } from "./serialize-json.js"
import { decodeAsTuples } from "./serialize-tuples.js"
import { decodeAsXML } from "./serialize-xml.js"
import type { DecoderToken } from "./types.js"

function tok(piece: string, start: number, end: number, label: BIOLabel, confidence = 1): DecoderToken {
	return { piece, start, end, label, confidence }
}

function proposal(
	body: string,
	start: number,
	component: ClassificationProposal["component"],
	source: ClassificationProposal["source"],
	sourceId: string
): ClassificationProposal {
	return {
		span: Span.from(body, { start }),
		component,
		confidence: 0.92,
		source,
		source_id: sourceId,
		penalty: 0,
	}
}

const PARIS_RAW = "75004 Paris, FR"

describe("Phase 4.1 source provenance", () => {
	describe("proposalsToTree", () => {
		test("threads source + source_id from ClassificationProposal onto AddressNode", () => {
			const tree = proposalsToTree(PARIS_RAW, [
				proposal("75004", 0, "postcode", "rule", "postcode"),
				proposal("Paris", 6, "locality", "rule", "whos_on_first"),
				proposal("FR", 13, "country", "neural", "neural-v0.3.1-en-us"),
			])
			expect(tree.roots).toHaveLength(3)
			expect(tree.roots[0]).toMatchObject({ tag: "postcode", source: "rule", sourceId: "postcode" })
			expect(tree.roots[1]).toMatchObject({ tag: "locality", source: "rule", sourceId: "whos_on_first" })
			expect(tree.roots[2]).toMatchObject({ tag: "country", source: "neural", sourceId: "neural-v0.3.1-en-us" })
		})

		test("XML serializer emits src='<source>:<sourceId>' attribute", () => {
			const tree = proposalsToTree(PARIS_RAW, [proposal("Paris", 6, "locality", "rule", "whos_on_first")])
			const xml = decodeAsXML(tree)
			expect(xml).toContain(`src="rule:whos_on_first"`)
		})

		test("includeSrc=false suppresses the src attribute", () => {
			const tree = proposalsToTree(PARIS_RAW, [proposal("Paris", 6, "locality", "rule", "whos_on_first")])
			const xml = decodeAsXML(tree, { includeSrc: false })
			expect(xml).not.toContain(`src=`)
			expect(xml).toContain(`conf=`) // other attrs unaffected
		})

		test("escapes XML special chars in src attribute", () => {
			const tree = proposalsToTree(PARIS_RAW, [proposal("Paris", 6, "locality", "rule", `evil"&<>`)])
			const xml = decodeAsXML(tree)
			expect(xml).toContain(`src="rule:evil&quot;&amp;&lt;&gt;"`)
		})

		test("JSON projection is unchanged when provenance is set", () => {
			const tree = proposalsToTree(PARIS_RAW, [
				proposal("75004", 0, "postcode", "rule", "postcode"),
				proposal("Paris", 6, "locality", "rule", "whos_on_first"),
			])
			expect(decodeAsJSON(tree)).toEqual({ postcode: "75004", locality: "Paris" })
		})

		test("tuple projection is unchanged when provenance is set", () => {
			const tree = proposalsToTree(PARIS_RAW, [
				proposal("75004", 0, "postcode", "rule", "postcode"),
				proposal("Paris", 6, "locality", "rule", "whos_on_first"),
			])
			expect(decodeAsTuples(tree)).toEqual([
				["postcode", "75004"],
				["locality", "Paris"],
			])
		})
	})

	describe("buildAddressTree", () => {
		const NYC_RAW = "New York NY"
		const NYC_TOKENS: DecoderToken[] = [
			tok("New", 0, 3, "B-locality"),
			tok("York", 4, 8, "I-locality"),
			tok("NY", 9, 11, "B-region"),
		]

		test("stamps caller-supplied source + sourceId on every emitted node", () => {
			const tree = buildAddressTree(NYC_RAW, NYC_TOKENS, {
				source: "neural",
				sourceId: "neural-v0.3.1-en-us",
			})
			// Locality is wrapped by region per containment rules; walk both.
			const all = [...tree.roots, ...tree.roots.flatMap((r) => r.children)]

			for (const node of all) {
				expect(node.source).toBe("neural")
				expect(node.sourceId).toBe("neural-v0.3.1-en-us")
			}
		})

		test("XML serializer emits the stamped src on nested nodes", () => {
			const tree = buildAddressTree(NYC_RAW, NYC_TOKENS, {
				source: "neural",
				sourceId: "neural-v0.3.1-en-us",
			})
			const xml = decodeAsXML(tree)
			expect(xml).toContain(`<region`)
			expect(xml).toContain(`<locality`)
			// Both region and locality carry the same neural attribution.
			const matches = [...xml.matchAll(/src="neural:neural-v0\.3\.1-en-us"/g)]
			expect(matches.length).toBeGreaterThanOrEqual(2)
		})

		test("omits source when only sourceId is set", () => {
			const tree = buildAddressTree(NYC_RAW, NYC_TOKENS, { sourceId: "anon" })
			expect(tree.roots[0].source).toBeUndefined()
			expect(tree.roots[0].sourceId).toBe("anon")
			const xml = decodeAsXML(tree)
			expect(xml).toContain(`src="anon"`)
		})

		test("omits sourceId when only source is set", () => {
			const tree = buildAddressTree(NYC_RAW, NYC_TOKENS, { source: "rule" })
			expect(tree.roots[0].source).toBe("rule")
			expect(tree.roots[0].sourceId).toBeUndefined()
			const xml = decodeAsXML(tree)
			expect(xml).toContain(`src="rule"`)
		})

		test("no opts → no src attribute (backwards compatible)", () => {
			const tree = buildAddressTree(NYC_RAW, NYC_TOKENS)
			expect(tree.roots[0].source).toBeUndefined()
			expect(tree.roots[0].sourceId).toBeUndefined()
			const xml = decodeAsXML(tree)
			expect(xml).not.toContain(`src=`)
		})
	})
})
