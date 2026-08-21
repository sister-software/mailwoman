/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins for the tally invariants: absence is a bucket, `null` is a value, and every tally sums to the row count. The
 *   sum-to-n property is the one that makes a tally readable as a distribution — a census that silently drops rows is
 *   the exact defect the recount scripts kept re-introducing by hand.
 */

import { ABSENT_KEY, readPath, tallyPath, tallyPaths } from "@mailwoman/dev-mcp/tally"
import { describe, expect, it } from "vitest"

const ROWS = [
	{ admin_coherence: { region: "confirmed" }, tier: "address" },
	{ admin_coherence: { region: "confirmed" }, tier: "address" },
	{ admin_coherence: { region: "contradicted" }, tier: "locality" },
	{ admin_coherence: { region: null }, tier: "locality" },
	{ tier: "locality" },
]

describe("readPath", () => {
	it("walks dotted paths and distinguishes absence from null", () => {
		expect(readPath(ROWS[0], "admin_coherence.region")).toEqual({ present: true, value: "confirmed" })
		expect(readPath(ROWS[3], "admin_coherence.region")).toEqual({ present: true, value: null })
		expect(readPath(ROWS[4], "admin_coherence.region")).toEqual({ present: false, value: undefined })
	})

	it("does not traverse arrays — a per-member tally has a different denominator", () => {
		expect(readPath({ list: [{ a: 1 }] }, "list.a")).toEqual({ present: false, value: undefined })
	})

	it("reports absence past a scalar rather than throwing", () => {
		expect(readPath({ tier: "address" }, "tier.deeper")).toEqual({ present: false, value: undefined })
	})
})

describe("tallyPath", () => {
	it("buckets absence under ABSENT_KEY and null under the string 'null', never merged", () => {
		expect(tallyPath(ROWS, "admin_coherence.region")).toEqual({
			confirmed: 2,
			contradicted: 1,
			null: 1,
			[ABSENT_KEY]: 1,
		})
	})

	it("sums to the row count for every path, including one no row carries", () => {
		for (const path of ["admin_coherence.region", "tier", "no.such.path"]) {
			const counts = tallyPath(ROWS, path)
			const total = Object.values(counts).reduce((sum, n) => sum + n, 0)

			expect(total).toBe(ROWS.length)
		}

		expect(tallyPath(ROWS, "no.such.path")).toEqual({ [ABSENT_KEY]: ROWS.length })
	})

	it("tallies object values under their JSON form instead of collapsing them", () => {
		expect(tallyPath(ROWS.slice(0, 2), "admin_coherence")).toEqual({ '{"region":"confirmed"}': 2 })
	})
})

describe("tallyPaths", () => {
	it("returns one tally per requested path, keyed by the path", () => {
		const tallies = tallyPaths(ROWS, ["tier", "admin_coherence.region"])

		expect(Object.keys(tallies)).toEqual(["tier", "admin_coherence.region"])
		expect(tallies["tier"]).toEqual({ address: 2, locality: 3 })
	})
})
