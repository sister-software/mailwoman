import { describe, expect, it } from "vitest"

import type { HeldoutRowOutcome } from "#tools/eval-harness/heldout/per/country"
import {
	byKindAndProvenance,
	byRowKind,
	bySourceWithin,
	equalCountryExactRate,
	formatPairedSplits,
	splitPairedOutcomes,
} from "#tools/eval-harness/heldout/per/paired-splits"

function outcome(rowID: string, overrides: Partial<HeldoutRowOutcome>): HeldoutRowOutcome {
	return {
		rowID,
		country: "DE",
		source: "osm-de",
		kind: "address",
		group: rowID,
		provenance: "verified_unseen",
		exact: true,
		streetConvention: "whole",
		streetJoinChanged: false,
		missingSpans: 0,
		additionalSpans: 0,
		spans: 1,
		spansRecovered: 1,
		goldRecovered: true,
		...overrides,
	}
}

const baseline = [
	outcome("a", { exact: true }),
	outcome("b", { exact: false }),
	outcome("c", { exact: true, kind: "gazetteer", provenance: "known_overlap", source: "wof-admin" }),
	outcome("d", { exact: false, country: "FR", source: "ban" }),
]

const candidate = [
	outcome("a", { exact: false }),
	outcome("b", { exact: true }),
	outcome("c", { exact: true, kind: "gazetteer", provenance: "known_overlap", source: "wof-admin" }),
	outcome("d", { exact: true, country: "FR", source: "ban" }),
]

describe("splitPairedOutcomes", () => {
	it("counts each split's rows, exact rows, fixes and breaks", () => {
		expect(splitPairedOutcomes([baseline, candidate], byRowKind)).toEqual([
			{ split: "address", rows: 3, baselineExact: 1, candidates: [{ exact: 2, fixes: 2, breaks: 1 }] },
			{ split: "gazetteer", rows: 1, baselineExact: 1, candidates: [{ exact: 1, fixes: 0, breaks: 0 }] },
		])
	})

	it("keys rows by kind and provenance together, and leaves out rows a key refuses", () => {
		expect(splitPairedOutcomes([baseline, candidate], byKindAndProvenance).map((s) => s.split)).toEqual([
			"address/verified_unseen",
			"gazetteer/known_overlap",
		])

		expect(
			splitPairedOutcomes([baseline, candidate], bySourceWithin("address", "verified_unseen")).map((s) => [
				s.split,
				s.rows,
			])
		).toEqual([
			["ban", 1],
			["osm-de", 2],
		])
	})

	it("refuses arms that are not paired by row identity", () => {
		expect(() => splitPairedOutcomes([baseline, candidate.toReversed()], byRowKind)).toThrow(/row 0/)
		expect(() => splitPairedOutcomes([baseline, candidate.slice(1)], byRowKind)).toThrow(/3 outcomes/)
		expect(() => splitPairedOutcomes([baseline], byRowKind)).toThrow(/at least one candidate/)
	})
})

describe("equalCountryExactRate", () => {
	it("weighs each country equally", () => {
		const rate = equalCountryExactRate([baseline, candidate], (o) => o.kind === "address")

		expect(rate.countries).toBe(2)
		expect(rate.rows).toBe(3)
		// The baseline gets DE 1 of 2 and FR 0 of 1.
		// The candidate gets DE 1 of 2 and FR 1 of 1.
		expect(rate.rates).toEqual([0.25, 0.75])
	})
})

describe("formatPairedSplits", () => {
	it("prints the difference in points beside fixes and breaks", () => {
		const lines = formatPairedSplits("by kind", splitPairedOutcomes([baseline, candidate], byRowKind), 1)

		expect(lines[0]).toBe("# by kind")
		expect(lines[2]).toBe(["address", "3", "33.33", "66.67", "33.33", "2", "1"].join("\t"))
	})
})
