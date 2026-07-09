/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type GBT, gbtScore, type TermFrequencyTable, trainGBT } from "@mailwoman/match"
import { describe, expect, it } from "vitest"

import { createGbtScorer, createMatchFeaturizer } from "./learned-scorer.ts"
import { buildDefaultModel } from "./resolve.ts"
import type { SourceRecord } from "./types.ts"

// A frequency table where one address string is "crowded" (weak identity evidence) and the rest rare.
const addressFrequency: TermFrequencyTable = {
	total: 1000,
	distinct: 500,
	frequency: (v: string) => (v.toUpperCase().includes("CROWDED") ? 0.5 : 0.0005),
}

const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons

function rec(id: string, given: string, family: string, key: string, raw: string): SourceRecord {
	return {
		id,
		name: { given, family },
		address: {
			components: {},
			canonicalKey: key,
			raw,
			geocode: { coordinate: { latitude: 40, longitude: -75 }, tier: "address_point", uncertaintyMeters: 1 },
		},
	}
}

describe("createMatchFeaturizer", () => {
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })
	// The trailing three features are [spatial×name-disagree, spatial×org-disagree, crowdedness].
	const tail = (a: SourceRecord, b: SourceRecord) => featurize(a, b).slice(-6)

	it("produces a one-hot-plus-tail vector of stable length", () => {
		const v = featurize(
			rec("1", "ann", "lee", "10 oak st", "10 OAK ST"),
			rec("2", "ann", "lee", "10 oak st", "10 OAK ST")
		)
		const expectedOneHot = comparisons.reduce((n, c) => n + c.levels.length, 0)
		expect(v).toHaveLength(expectedOneHot + 6) // 3 interaction/crowd + 3 roll-up (#625 adjudication)
		expect(v.every((x) => x >= 0)).toBe(true)
	})

	it("fires the over-merge interaction: same address, DIFFERENT names → spatial×name-disagree = 1", () => {
		const a = rec("1", "ann", "lee", "10 oak st", "10 OAK ST")
		const b = rec("2", "bob", "ng", "10 oak st", "10 OAK ST") // co-located, names disagree
		expect(tail(a, b)[0]).toBe(1)
	})

	it("does NOT fire the interaction when the co-located records AGREE on name", () => {
		const a = rec("1", "ann", "lee", "10 oak st", "10 OAK ST")
		const b = rec("2", "ann", "lee", "10 oak st", "10 OAK ST") // co-located, names agree
		expect(tail(a, b)[0]).toBe(0)
	})

	it("fires the roll-up signature (#625): same official + org disagree + co-located", () => {
		const a = {
			...rec("1", "", "", "10 oak st", "10 OAK ST"),
			organization: { canonical: "sunrise home care", raw: "Sunrise Home Care" },
			attributes: { authorizedOfficial: "shane lewis" },
		}
		const b = {
			...rec("2", "", "", "10 oak st", "10 OAK ST"),
			organization: { canonical: "bluebonnet health services", raw: "Bluebonnet Health Services" },
			attributes: { authorizedOfficial: "shane lewis" },
		}
		const t = tail(a, b)
		expect(t[3]).toBe(1) // officialAgree
		expect(t[4]).toBe(1) // officialAgree × orgDisagree — the roll-up core
		expect(t[5]).toBe(1) // …at the same place
		// Same officials but org names AGREE → the roll-up features must NOT fire.
		const c = { ...b, organization: { canonical: "sunrise home care", raw: "Sunrise Home Care" } }
		const t2 = tail(a, c)
		expect(t2[4]).toBe(0)
		expect(t2[5]).toBe(0)
	})

	it("reflects address crowdedness in the trailing feature", () => {
		const crowded = tail(
			rec("1", "ann", "lee", "1 plaza", "1 PLAZA CROWDED BLDG"),
			rec("2", "bob", "ng", "1 plaza", "1 PLAZA CROWDED BLDG")
		)[2]
		const rare = tail(
			rec("3", "ann", "lee", "9 lane", "9 QUIET LANE"),
			rec("4", "bob", "ng", "9 lane", "9 QUIET LANE")
		)[2]
		expect(crowded).toBeGreaterThan(rare) // a crowded address scores higher on the crowdedness feature
	})
})

describe("createGbtScorer", () => {
	it("applies the trained model to the pair's features (= gbtScore ∘ featurize)", () => {
		const featurize = createMatchFeaturizer({ comparisons, addressFrequency })
		const a = rec("1", "ann", "lee", "10 oak st", "10 OAK ST")
		const b = rec("2", "ann", "lee", "10 oak st", "10 OAK ST")
		// A trivial model trained so its score is well-defined; we only assert the wiring is consistent.
		const x = featurize(a, b)
		const dim = x.length
		const model: GBT = trainGBT([x, new Array<number>(dim).fill(0)], [1, 0], [1, 1], {
			rounds: 5,
			depth: 2,
			lr: 0.3,
			minLeaf: 1,
		})
		const scorer = createGbtScorer({ comparisons, addressFrequency, model })
		// The scorer must equal gbtScore over the identical featurization.
		expect(scorer(a, b)).toBeCloseTo(gbtScore(model, featurize(a, b)), 10)
	})
})
