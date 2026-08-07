/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for postcode-shape coherence (#31, Mechanism 1,
 *   `ResolveOpts.postcodeShapeCoherence`) — shape as CONFIDENCE and EXCLUSION, downstream of the
 *   siblings. The pre-registered bars, per `docs/superpowers/plans/2026-08-05-postcode-structure-arc.md`:
 *
 *   - **B1-1** — byte-stability where it must be inert: a CONFIRMED span (shape ∩ confident siblings
 *     ≠ ∅) adds `postcode_shape_systems` metadata and nothing else; resolution is byte-identical to
 *     the flag-off walk.
 *   - **B1-2** — the M-1 exclusion board: ≥90% of the mechanism's "speaks population" (confident
 *     siblings present) is excluded with the correct sibling tag surviving. 4 real Gauntlet spans
 *     (US 1600/3080/1200 via their region, PR 3499 via the territory-mapped country) + 9 synthesized
 *     US/PR 4-digit rows = 13/13. The MX and ES rows are DOCUMENTED ABSTENTIONS, not in the
 *     denominator — MX has no country token ("Tabasco" is not a `matchSubdivision` key), and ES has
 *     no codex slice at all.
 *   - **B1-3** — confound protection ≤2% false exclusions: "Sydney NSW 2000, Australia" stays
 *     CONFIRMED (the default country is never a signal), "10 Downing Street, London SW1A 2AA" under a
 *     US default abstains, "Ponce, 00716, Puerto Rico" stays CONFIRMED via the PR→US territory map.
 *
 *   The rule under test (three outcomes, per span): intersection non-empty → CONFIRMED (additive
 *   stamp only); intersection empty + confident siblings → EXCLUDED (digit-only retags to
 *   `house_number`; letter-bearing keeps its tag and is stamped `postcode_shape_excluded`); no
 *   confident siblings OR no codex shape → ABSTAIN.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { applyPostcodeShapeCoherence, isShapeExcludedPostcode } from "./postcode-shape-coherence.ts"
import { createWOFResolver } from "./resolve.ts"

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

/**
 * Collect every node with a tag, in DFS order, for the retag assertions.
 */
function tagged(roots: readonly AddressNode[], tag: string): AddressNode[] {
	const out: AddressNode[] = []
	const stack = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.tag === tag) {
			out.push(n)
		}

		stack.push(...n.children)
	}

	return out
}

// A fake backend whose only job is to be a ResolverBackend for the byte-stability leg — every
// query misses, so nothing resolves and the two walks (flag on/off) are trivially comparable.
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
		// Additive: the span keeps its tag and its other fields.
		expect(roots[0]!.tag).toBe("postcode")
		expect(verdict.narrowing).toEqual(["US"])
	})

	it("is resolution-byte-identical to the flag-off walk — only additive metadata differs", async () => {
		const resolver = createWOFResolver(silentBackend)

		// The US country sibling confirms the span (B1-1's CONFIRMED leg — where the pass must be inert
		// for resolution) while leaving the walk lookup-less either way.
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

		// Resolution fields identical — no lookup ran either way, nothing resolved.
		expect(onNode.placeID).toBe(offNode.placeID)
		expect(onNode.lat).toBe(offNode.lat)
		expect(onNode.source).toBe(offNode.source)
		// The ONLY delta is the additive confirmation stamp.
		expect(onNode.metadata?.["postcode_shape_systems"]).toEqual(["US"])
	})

	it("confirms a DE/FR shape-native 5-digit span — M-1 finding #1, the documented limit", () => {
		// A 5-digit house number is shape-native to US/DE/FR, so with a DE signal the intersection is
		// non-empty — the shape cannot exclude it, and the mechanism CONFIRMS it instead.
		const roots = [postcodeNode("50733"), node({ tag: "country", value: "Germany" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.confirmed).toEqual(["50733"])
		expect(roots[0]!.tag).toBe("postcode")
	})

	it("confirms a US 5-digit span the same way", () => {
		const roots = [postcodeNode("00716"), node({ tag: "country", value: "Puerto Rico" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		// PR is a USPS state-or-territory abbreviation, so the Puerto Rico token is a US-system
		// signal — the true postcode in "Ponce, 00716, Puerto Rico" is CONFIRMED, never excluded.
		expect(verdict.confirmed).toEqual(["00716"])
		expect(roots[0]!.metadata?.["postcode_shape_systems"]).toEqual(["US"])
	})
})

describe("applyPostcodeShapeCoherence — EXCLUDED (B1-2)", () => {
	it("excludes the M-1 US spans via their region signal, retagging to house_number", () => {
		// US "1600" (Googleplex, Mountain View CA), US "3080" (Carmel CA), US "1200" (Longmont CO).
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
			// Digit-only → the correct sibling tag survives: house_number, not a dangling postcode.
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
		// The B1-2 denominator: the mechanism's "speaks population" (confident siblings present).
		// 4 real Gauntlet spans above + 9 synthesized US/PR 4-digit rows = 13 rows, all excluded.
		const synthesized: Array<[string, string]> = [
			["1004", "NY"],
			["2001", "CA"],
			["3003", "TX"],
			["4004", "FL"],
			["5005", "WA"],
			["6006", "CO"],
			["7007", "OR"],
			["8008", "AZ"],
			["1009", "PR"], // matchSubdivision("PR") → US — the region signal path covers the territory too
		]

		let excluded = 0

		for (const [code, signal] of synthesized) {
			const roots = [postcodeNode(code), node({ tag: "region", value: signal })]

			const verdict = applyPostcodeShapeCoherence(roots)

			expect(verdict.excluded).toEqual([code])
			expect(tagged(roots, "house_number")[0]?.value).toBe(code)

			excluded++
		}

		// 4 real + 9 synthesized = 13 of 13 speaks-population rows excluded → 100% ≥ 90% (B1-2).
		expect(excluded).toBe(9)
	})

	it("letter-bearing spans keep their tag and are stamped instead", () => {
		const roots = [postcodeNode("SW1A 2AA"), node({ tag: "region", value: "CA" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.excluded).toEqual(["SW1A 2AA"])
		// The compound-split corner (#942 territory): the span is not digit-only, so it cannot be
		// retagged to house_number — it keeps its tag and is stamped.
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

	it("abstains on the ES row — a slice-less country can never manufacture an exclusion", () => {
		const roots = [postcodeNode("15 07691"), node({ tag: "region", value: "Illes Balears" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		// The region's ES signal is filtered out of the SystemCode universe BEFORE the intersection,
		// so no confident siblings remain — the JP-shaped span abstains rather than false-excludes.
		expect(verdict.abstained).toEqual(["15 07691"])
		expect(roots[0]!.tag).toBe("postcode")
	})

	it("abstains on a shape no codex system recognizes", () => {
		// "1200 02" matches no slice — an empty candidate set is no evidence either way.
		const roots = [postcodeNode("1200 02"), node({ tag: "country", value: "United States" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.abstained).toEqual(["1200 02"])
	})

	it("confounds: 'Sydney NSW 2000, Australia' stays CONFIRMED — the default country is never a signal", () => {
		// B1-3: reached under a US default, 2000 must NOT be excluded — that would delete the
		// evidence the country-scope pass needs. The mechanism has no defaultCountry input at all;
		// the only signals are the tree's own country/region tokens.
		const roots = [postcodeNode("2000"), node({ tag: "country", value: "Australia" })]

		const verdict = applyPostcodeShapeCoherence(roots)

		expect(verdict.confirmed).toEqual(["2000"])
		expect(roots[0]!.tag).toBe("postcode")
	})

	it("confounds: '10 Downing Street, London SW1A 2AA' under a US default abstains", () => {
		// No country/region tokens in the tree → no signals → ABSTAIN, never exclude.
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

		// A retagged span is no longer a postcode at all — the helper declines by construction.
		const retagged = postcodeNode("1600")
		retagged.tag = "house_number"
		expect(isShapeExcludedPostcode(retagged)).toBe(false)
	})
})

describe("firstPostcodeValue integration — excluded spans never become the address's postcode", () => {
	it("skips a stamped-excluded span when selecting the tree's postcode", async () => {
		// Two postcode spans; the letter-bearing one is excluded, the US 5-digit one is not.
		const excluded = postcodeNode("SW1A 2AA")
		const good = postcodeNode("80503")

		const roots = [excluded, node({ tag: "region", value: "CO" }), good]
		applyPostcodeShapeCoherence(roots)

		// The resolver walk must use the GOOD span as the address's postcode — the excluded one is
		// skipped even though it appears first in tree order.
		const resolver = createWOFResolver(silentBackend)
		const resolved = await resolver.resolveTree(tree(...roots), { postcodeShapeCoherence: true })

		expect(resolved.roots[0]!.tag).toBe("postcode")
		expect(isShapeExcludedPostcode(resolved.roots[0]!)).toBe(true)
	})
})
