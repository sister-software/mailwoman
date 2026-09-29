/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { walkNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { applyPostcodeShapeCoherence, isShapeExcludedPostcode } from "#postcode"
import { createWOFResolver } from "#resolve"

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode => ({
	start: 0,
	end: over.value.length,
	confidence: 0.95,
	children: [],
	...over,
})

function tree(...roots: AddressNode[]): AddressTree {
	return { raw: roots.map((r) => r.value).join(" "), roots }
}

function postcodeNode(code: string): AddressNode {
	return node({ tag: "postcode", value: code })
}

function tagged(roots: readonly AddressNode[], tag: string): AddressNode[] {
	const out: AddressNode[] = []

	for (const n of walkNodes(roots)) {
		if (n.tag === tag) {
			out.push(n)
		}
	}

	return out
}

const silentBackend: ResolverBackend = {
	findPlace: async () => [],
}

describe("applyPostcodeShapeCoherence — CONFIRMED (B1-1)", () => {
	it("stamps the narrowed systems on a span whose shape intersects a confident sibling system", () => {
		const roots = [postcodeNode("94103"), node({ tag: "country", value: "United States" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.confirmed).toEqual(["94103"])
		expect(verdict.excluded).toEqual([])
		expect(verdict.abstained).toEqual([])
		// 94103's codex shape is [us, de, fr]; the US country signal narrows it to exactly ["US"].
		expect(roots[0]!.metadata?.["postcode_shape_systems"]).toEqual(["US"])
		expect(roots[0]!.tag).toBe("postcode")
		expect(verdict.narrowing).toEqual(["US"])
	})

	it("is resolution-byte-identical to the flag-off walk — only additive metadata differs", async () => {
		const resolver = createWOFResolver(silentBackend)

		const mkTree = () =>
			tree(
				node({ tag: "street", value: "Twin Peaks" }),
				postcodeNode("94103"),
				node({ tag: "country", value: "United States" })
			)

		const off = await resolver.resolveTree(mkTree(), {})
		const on = await resolver.resolveTree(mkTree(), { postcodeShapeCoherence: true })

		const offNode = tagged(off.roots, "postcode")[0]!
		const onNode = tagged(on.roots, "postcode")[0]!

		expect(onNode.placeID).toBe(offNode.placeID)
		expect(onNode.lat).toBe(offNode.lat)
		expect(onNode.source).toBe(offNode.source)
		expect(onNode.metadata?.["postcode_shape_systems"]).toEqual(["US"])
	})

	it("confirms a DE/FR shape-native 5-digit span — M-1 finding #1, the documented limit", () => {
		// A 5-digit house number is shape-native to US/DE/FR, so with a DE signal the
		// intersection is non-empty and the shape confirms rather than excludes.
		const roots = [postcodeNode("50733"), node({ tag: "country", value: "Germany" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.confirmed).toEqual(["50733"])
		expect(roots[0]!.tag).toBe("postcode")
	})

	it("confirms a US 5-digit span the same way", () => {
		const roots = [postcodeNode("00716"), node({ tag: "country", value: "Puerto Rico" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		// PR is a USPS state-or-territory abbreviation, so the Puerto Rico token is a US-system signal.
		expect(verdict.confirmed).toEqual(["00716"])
		expect(roots[0]!.metadata?.["postcode_shape_systems"]).toEqual(["US"])
	})
})

describe("applyPostcodeShapeCoherence — EXCLUDED (B1-2)", () => {
	it("excludes the M-1 US spans via their region signal, retagging to house_number", () => {
		const cases: Array<[string, string]> = [
			["1600", "CA"],
			["3080", "CA"],
			["1200", "CO"],
		]

		for (const [code, region] of cases) {
			const roots = [postcodeNode(code), node({ tag: "region", value: region })]

			const verdict = applyPostcodeShapeCoherence(roots)

			expect(verdict.excluded).toEqual([code])
			expect(verdict.confirmed).toEqual([])
			const span = tagged(roots, "house_number")[0]
			expect(span?.value).toBe(code)
			expect(tagged(roots, "postcode")).toEqual([])
		}
	})

	it("excludes the PR 3499 span via the territory-mapped country signal", () => {
		const roots = [postcodeNode("3499"), node({ tag: "country", value: "Puerto Rico" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.excluded).toEqual(["3499"])
		expect(tagged(roots, "house_number")[0]?.value).toBe("3499")
	})

	it("excludes 9 synthesized US/PR 4-digit rows — the speaks-population board totals 13/13", () => {
		const synthesized: Array<[string, string]> = [
			["1004", "NY"],
			["2001", "CA"],
			["3003", "TX"],
			["4004", "FL"],
			["5005", "WA"],
			["6006", "CO"],
			["7007", "OR"],
			["8008", "AZ"],
			["1009", "PR"], // matchSubdivision("PR") maps to US, so the region signal path covers the territory.
		]

		let excluded = 0

		for (const [code, signal] of synthesized) {
			const roots = [postcodeNode(code), node({ tag: "region", value: signal })]

			const verdict = applyPostcodeShapeCoherence(roots)

			expect(verdict.excluded).toEqual([code])
			expect(tagged(roots, "house_number")[0]?.value).toBe(code)

			excluded++
		}

		expect(excluded).toBe(9)
	})

	it("letter-containing spans keep their tag and are stamped instead", () => {
		const roots = [postcodeNode("SW1A 2AA"), node({ tag: "region", value: "CA" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.excluded).toEqual(["SW1A 2AA"])
		// The span is not digit-only, so it cannot be retagged to house_number and is stamped instead.
		expect(roots[0]!.tag).toBe("postcode")
		expect(isShapeExcludedPostcode(roots[0]!)).toBe(true)
	})
})

describe("applyPostcodeShapeCoherence — ABSTENTIONS (B1-2 documented, B1-3 confound)", () => {
	it("abstains on the MX row — no country token, 'Tabasco' is not a matchSubdivision key", () => {
		const roots = [postcodeNode("2000"), node({ tag: "region", value: "Tabasco" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.abstained).toEqual(["2000"])
		expect(roots[0]!.tag).toBe("postcode")
	})

	it("abstains on the ES row — a country without a codex system can never manufacture an exclusion", () => {
		const roots = [postcodeNode("15 07691"), node({ tag: "region", value: "Illes Balears" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		// The region's ES signal is filtered out of the SystemCode universe, so no confident
		// siblings remain and the span abstains rather than false-excludes.
		expect(verdict.abstained).toEqual(["15 07691"])
		expect(roots[0]!.tag).toBe("postcode")
	})

	it("abstains on a shape no codex system recognizes", () => {
		// An empty candidate set is no evidence either way.
		const roots = [postcodeNode("1200 02"), node({ tag: "country", value: "United States" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.abstained).toEqual(["1200 02"])
	})

	it("confounds: 'Sydney NSW 2000, Australia' stays CONFIRMED — the default country is never a signal", () => {
		// The mechanism has no defaultCountry input: the only signals are the tree's own country/region tokens.
		const roots = [postcodeNode("2000"), node({ tag: "country", value: "Australia" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.confirmed).toEqual(["2000"])
		expect(roots[0]!.tag).toBe("postcode")
	})

	it("confounds: '10 Downing Street, London SW1A 2AA' under a US default abstains", () => {
		const roots = [postcodeNode("SW1A 2AA")]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.abstained).toEqual(["SW1A 2AA"])
		expect(roots[0]!.tag).toBe("postcode")
	})
})

describe("isShapeExcludedPostcode", () => {
	it("only recognizes the exclusion stamp, never a plain postcode", () => {
		expect(isShapeExcludedPostcode(postcodeNode("94103"))).toBe(false)

		const stamped = postcodeNode("SW1A 2AA")
		stamped.metadata = { postcode_shape_excluded: true }
		expect(isShapeExcludedPostcode(stamped)).toBe(true)

		const retagged = postcodeNode("1600")
		retagged.tag = "house_number"
		expect(isShapeExcludedPostcode(retagged)).toBe(false)
	})
})

describe("firstPostcodeValue integration — excluded spans never become the address's postcode", () => {
	it("skips a stamped-excluded span when selecting the tree's postcode", async () => {
		const excluded = postcodeNode("SW1A 2AA")
		const good = postcodeNode("80503")

		const roots = [excluded, node({ tag: "region", value: "CO" }), good]
		applyPostcodeShapeCoherence(roots)

		const resolver = createWOFResolver(silentBackend)
		const resolved = await resolver.resolveTree(tree(...roots), { postcodeShapeCoherence: true })

		expect(resolved.roots[0]!.tag).toBe("postcode")
		expect(isShapeExcludedPostcode(resolved.roots[0]!)).toBe(true)
	})
})
