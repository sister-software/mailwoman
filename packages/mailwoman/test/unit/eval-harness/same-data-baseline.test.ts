/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The same-data benchmark's baseline resolver and its scorer (#2261).
 *
 *   THE BASELINE MUST BE ABLE TO WIN. A baseline that cannot read a qualifier would lose the homograph
 *   stratum to its own blindness and the benchmark would measure nothing, so the first two cases pin that
 *   a country qualifier resolved INSIDE the pool flips the selection — using only facts the production arm
 *   also received.
 *
 *   THE EXACT TEST IS PINNED AGAINST ITS CLOSED FORM. `mcnemarExactP` builds its terms by ratio to avoid
 *   forming a factorial, so the cases below check it against values computed from the binomial directly:
 *   a 6/0 split is 2 × 2⁻⁶, a 5/0 split is 2 × 2⁻⁵ and does NOT reject, and 12/3 is
 *   2 × (1 + 15 + 105 + 455) / 2¹⁵.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { ABLATION_RESOLVE_OPTS } from "mailwoman/eval-harness/same-data/arms"
import { BASELINE_SIMILARITY_FLOOR, selectBaseline } from "mailwoman/eval-harness/same-data/baseline"
import { loadSameDataDefinition } from "mailwoman/eval-harness/same-data/definition"
import { candidatePool, type SameDataCandidate } from "mailwoman/eval-harness/same-data/fixture"
import { mcnemarExactP } from "mailwoman/eval-harness/same-data/score"
import { describe, expect, it } from "vitest"

function locality(id: number, name: string, country: string, population: number): SameDataCandidate {
	return { id, name, placetype: "locality", country, lat: 0.1, lon: 0.1, score: 10, population }
}

function tree(raw: string, nodes: Array<[string, string]>): AddressTree {
	return {
		raw,
		roots: nodes.map(([tag, value], index) => ({
			tag: tag as AddressTree["roots"][number]["tag"],
			value,
			start: index,
			end: index + value.length,
			confidence: 0.9,
			children: [],
		})),
	}
}

const WHITBY_CA = locality(101, "Whitby", "CA", 128_377)
const WHITBY_GB = locality(202, "Whitby", "GB", 13_130)

const UNITED_KINGDOM: SameDataCandidate = {
	id: 303,
	name: "United Kingdom",
	placetype: "country",
	country: "GB",
	lat: 54,
	lon: -2,
	score: 9,
}

describe("same-data baseline (#2261)", () => {
	it("selects the exact name match and reports its components", () => {
		const pool = candidatePool([
			{ key: "k", query: { text: "Whitby" }, candidates: [locality(1, "Whitbourne", "GB", 500), WHITBY_GB] },
		])

		const selected = selectBaseline(tree("Whitby", [["locality", "Whitby"]]), pool)

		expect(selected.placeID).toBe("202")
		expect(selected.components?.exact).toBe(1)
	})

	it("lets a country qualifier resolved inside the pool flip a homograph", () => {
		const pool = candidatePool([
			{ key: "k", query: { text: "Whitby" }, candidates: [WHITBY_CA, WHITBY_GB, UNITED_KINGDOM] },
		])

		const unqualified = selectBaseline(tree("Whitby", [["locality", "Whitby"]]), pool)

		const qualified = selectBaseline(
			tree("Whitby, United Kingdom", [
				["locality", "Whitby"],
				["country", "United Kingdom"],
			]),
			pool
		)

		// Unqualified, the tie breaks on the pool's canonical order — the baseline ranks on no fame term at all.
		expect(unqualified.placeID).toBe("101")
		expect(qualified.placeID).toBe("202")
		expect(qualified.components?.countryQualifier).toBe(1)
	})

	it("abstains rather than selecting a best partial match below the similarity floor", () => {
		const pool = candidatePool([
			{ key: "k", query: { text: "Middlebury" }, candidates: [locality(9, "Zaragoza", "ES", 600_000)] },
		])

		const selected = selectBaseline(tree("Middlebury", [["locality", "Middlebury"]]), pool)

		expect(selected.placeID).toBeNull()
		expect(selected.abstainedBecause).toBe("below_similarity_floor")
		expect(selected.components?.similarity).toBeLessThan(BASELINE_SIMILARITY_FLOOR)
	})

	it("abstains when the tree carries no admin node", () => {
		const selected = selectBaseline(tree("12", [["house_number", "12"]]), [WHITBY_GB])

		expect(selected.placeID).toBeNull()
		expect(selected.abstainedBecause).toBe("no_admin_node")
	})

	it("answers identically on repeated runs over one pool", () => {
		const pool = candidatePool([{ key: "k", query: { text: "Whitby" }, candidates: [WHITBY_CA, WHITBY_GB] }])
		const subject = tree("Whitby", [["locality", "Whitby"]])

		expect(selectBaseline(subject, pool)).toEqual(selectBaseline(subject, pool))
	})
})

describe("same-data scorer (#2261)", () => {
	it("computes the exact McNemar p-value from the binomial", () => {
		expect(mcnemarExactP(0, 0)).toBe(1)
		expect(mcnemarExactP(6, 0)).toBeCloseTo(2 * 2 ** -6, 12)
		expect(mcnemarExactP(5, 0)).toBeCloseTo(2 * 2 ** -5, 12)
		expect(mcnemarExactP(12, 3)).toBeCloseTo((2 * (1 + 15 + 105 + 455)) / 2 ** 15, 12)
	})

	it("rejects a 6/0 split and does not reject a 5/0 split at alpha 0.05", () => {
		expect(mcnemarExactP(6, 0)).toBeLessThanOrEqual(0.05)
		expect(mcnemarExactP(5, 0)).toBeGreaterThan(0.05)
	})

	it("is symmetric in its two arms", () => {
		expect(mcnemarExactP(12, 3)).toBe(mcnemarExactP(3, 12))
	})
})

describe("same-data ablation pins (#2261)", () => {
	it("pins exactly the options the frozen ruler registers", async () => {
		const definition = await loadSameDataDefinition()
		const registered = definition.arms.find((arm) => arm.id === "ablation")?.resolveOpts

		expect(registered).toEqual(ABLATION_RESOLVE_OPTS)
	})
})
