/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The refinement-monotonicity instrument, over hand-built resolver traces. No model, no gazetteer — the
 *   whole point of taking {@link ResolveNodeTrace} as the input is that every reading can be stated as a
 *   table and checked without resolving anything.
 *
 *   THE TWO ASYMMETRIES ARE THE TESTS THAT MATTER. A removal at the window leaves the row UNMEASURED, because
 *   the observation could not decide it. An addition at the window does NOT, because the law constrains what
 *   refinement removes — and a naïve `top5(refined) ⊆ top5(base)` assertion gets exactly that case wrong, in
 *   the direction that fails valid refinements. Both are asserted here rather than left to the live suite,
 *   where a run that happens to produce neither would report the same green as a run that handles both.
 *
 *   AND `unexplained` IS ASSERTED IN BOTH DIRECTIONS, because the live suite does not produce it: the shipped
 *   pipeline holds this law on every committed row, so the failing branch has no live witness and would
 *   otherwise ship unexercised.
 */

import type { ResolveCandidateTrace, ResolveNodeTrace } from "@mailwoman/core/resolver"
import {
	accountRefinement,
	CANDIDATE_ACCOUNTS,
	CANDIDATE_DIRECTIONS,
	foldLookups,
} from "mailwoman/eval-harness/conformance/candidate-admissibility"
import { describe, expect, it } from "vitest"

interface CandidateSpec {
	id: number
	name?: string
	country?: string
	placetype?: string
}

function candidate(spec: CandidateSpec): ResolveCandidateTrace {
	return {
		id: spec.id,
		name: spec.name ?? `place-${spec.id}`,
		country: spec.country ?? "US",
		placetype: spec.placetype ?? "locality",
		score: 1,
		ranks: { initial: 1 },
	}
}

interface LookupSpec {
	value?: string
	tag?: string
	placetype?: string
	candidates: CandidateSpec[]
	limit?: number
	truncated?: number
	country?: string
	parentID?: string | number
	regionQualifier?: string
	postcode?: string
	checks?: string[]
	picked?: ResolveNodeTrace["picked"]
}

function lookup(spec: LookupSpec): ResolveNodeTrace {
	return {
		tag: spec.tag ?? "locality",
		value: spec.value ?? "Springfield",
		placetype: spec.placetype ?? "locality",
		query: {
			limit: spec.limit ?? 5,
			...(spec.country ? { country: spec.country } : {}),
			...(spec.parentID === undefined ? {} : { parentID: spec.parentID }),
			...(spec.regionQualifier ? { regionQualifier: spec.regionQualifier } : {}),
			...(spec.postcode ? { postcode: spec.postcode } : {}),
		},
		checks: spec.checks ?? [],
		candidates: spec.candidates.map(candidate),
		candidatesTruncated: spec.truncated ?? 0,
		picked: spec.picked ?? null,
	}
}

describe("the account vocabularies", () => {
	it("are closed and disjoint from one another", () => {
		expect(new Set(CANDIDATE_ACCOUNTS).size).toBe(CANDIDATE_ACCOUNTS.length)
		expect(new Set(CANDIDATE_DIRECTIONS).size).toBe(CANDIDATE_DIRECTIONS.length)
		expect(CANDIDATE_ACCOUNTS).toContain("unexplained")
	})
})

describe("folding a run's lookups", () => {
	it("collapses repeats of one lookup into a single pool, keeping the BEST rank observed", () => {
		const folds = foldLookups([
			lookup({ candidates: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
			lookup({ candidates: [{ id: 3 }, { id: 1 }] }),
		])

		expect(folds.size).toBe(1)

		const fold = [...folds.values()][0]!

		expect(fold.records).toBe(2)
		expect([...fold.pool.keys()]).toEqual(["locality:1", "locality:2", "locality:3"])
		expect(fold.pool.get("locality:3")!.rank).toBe(1)
		expect(fold.pool.get("locality:1")!.rank).toBe(1)
	})

	it("pairs lookups by what was asked, so the same value under different scopes is one lookup", () => {
		const bare = foldLookups([lookup({ candidates: [{ id: 1 }] })])
		const scoped = foldLookups([lookup({ candidates: [{ id: 1 }], country: "US", parentID: 42 })])

		expect([...bare.keys()]).toEqual([...scoped.keys()])
	})

	it("folds the value case-insensitively and trimmed — the walk records the raw span", () => {
		const folds = foldLookups([
			lookup({ value: "Springfield", candidates: [{ id: 1 }] }),
			lookup({ value: "  springfield ", candidates: [{ id: 2 }] }),
		])

		expect(folds.size).toBe(1)
		expect([...folds.values()][0]!.pool.size).toBe(2)
	})

	it("reads BOTH ways a table can fall short of the candidate universe", () => {
		const full = foldLookups([lookup({ candidates: [{ id: 1 }, { id: 2 }], limit: 2 })])
		const overflowed = foldLookups([lookup({ candidates: [{ id: 1 }], limit: 5, truncated: 3 })])
		const roomy = foldLookups([lookup({ candidates: [{ id: 1 }], limit: 5 })])

		expect([...full.values()][0]!.windowed, "asked for 2 and got 2").toBe(true)
		expect([...overflowed.values()][0]!.windowed, "the trace cap counted a tail").toBe(true)
		expect([...roomy.values()][0]!.windowed, "1 of 5 — the backend had nothing more to give").toBe(false)
	})
})

describe("reading a refinement pair", () => {
	it("reports a pool that did not move as refines, with nothing to say about it", () => {
		const pool = [{ id: 1 }, { id: 2 }]

		const reading = accountRefinement(
			[lookup({ candidates: pool, limit: 5 })],
			[lookup({ candidates: pool, limit: 5 })]
		)

		expect(reading.relation).toBe("refines")
		expect(reading.differences).toEqual([])
		expect(reading.counts.held).toBe(2)
		expect(reading.pairedLookups).toBe(1)
	})

	it("does not fail a rank-only change, and says which way the rank moved", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1 }, { id: 2 }], limit: 5 })],
			[lookup({ candidates: [{ id: 2 }, { id: 1 }], limit: 5 })]
		)

		expect(reading.relation).toBe("refines")
		expect(reading.counts.held).toBe(2)
		expect(reading.counts.unexplained).toBe(0)
		expect(reading.differences.join("\n")).toContain("rank 1 → 2")
	})

	it("explains a removal the refined lookup's country scope contradicts", () => {
		const reading = accountRefinement(
			[
				lookup({
					candidates: [
						{ id: 1, country: "DE" },
						{ id: 2, country: "IT" },
					],
					limit: 5,
				}),
			],
			[lookup({ candidates: [{ id: 1, country: "DE" }], limit: 5, country: "DE" })]
		)

		expect(reading.relation).toBe("refines")
		expect(reading.counts.contradicted).toBe(1)

		const account = reading.readings.find((entry) => entry.key === "locality:2")!

		expect(account.account).toBe("contradicted")
		expect(account.direction).toBe("removed")
		expect(account.reason).toContain("country IT fails")
	})

	it("reads a contradiction even when the refined table is at its window — it is provable either way", () => {
		const reading = accountRefinement(
			[
				lookup({
					candidates: [
						{ id: 1, country: "DE" },
						{ id: 2, country: "IT" },
					],
					limit: 5,
				}),
			],
			[lookup({ candidates: [{ id: 1, country: "DE" }], limit: 1, country: "DE" })]
		)

		expect(reading.relation).toBe("refines")
		expect(reading.counts.contradicted).toBe(1)
		expect(reading.counts.beyond_window).toBe(0)
	})

	it("explains a removal from a lookup re-scoped through a different hierarchy path", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1 }, { id: 2 }], limit: 5 })],
			[lookup({ candidates: [{ id: 1 }], limit: 5, country: "US", parentID: 85_688_697 })]
		)

		expect(reading.relation).toBe("refines")
		expect(reading.counts.rescoped).toBe(1)
		expect(reading.readings.find((entry) => entry.key === "locality:2")!.reason).toContain("parent 85688697")
	})

	it("leaves a removal at the refined table's window UNMEASURED, never inadmissible", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1 }, { id: 2 }, { id: 3 }], limit: 5 })],
			[lookup({ candidates: [{ id: 1 }], limit: 1 })]
		)

		expect(reading.relation).toBe("unmeasured")
		expect(reading.counts.unexplained).toBe(0)
		expect(reading.counts.beyond_window).toBe(2)
	})

	// The refined table being short does not explain a candidate ARRIVING: its window bounds what the refined
	// lookup could show, never what the base's roomy table failed to hold.
	it("does not let the refined table's own window explain an addition the base had room for", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1 }, { id: 2 }, { id: 3 }], limit: 5 })],
			[lookup({ candidates: [{ id: 1 }, { id: 4 }], limit: 2 })]
		)

		expect(reading.relation).toBe("diverges")
		expect(reading.readings.find((entry) => entry.key === "locality:4")!.account).toBe("unexplained")
		expect(reading.readings.find((entry) => entry.key === "locality:2")!.account).toBe("beyond_window")
	})

	// The case a `top5(refined) ⊆ top5(base)` assertion fails and this instrument must not: the refined query
	// surfaced a candidate that was sixth before, and the base table is the only reason nobody saw it.
	it("explains an ADDITION by the base's own window, and does not hold the row back for it", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1 }, { id: 2 }], limit: 2 })],
			[lookup({ candidates: [{ id: 1 }, { id: 2 }, { id: 9 }], limit: 5 })]
		)

		expect(reading.relation).toBe("refines")
		expect(reading.counts.beyond_window).toBe(1)

		const account = reading.readings.find((entry) => entry.key === "locality:9")!

		expect(account.direction).toBe("added")
		expect(account.reason).toContain("never observed absent")
	})

	it("fails a removal with no contradiction, no re-scope, and a table that had room", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1 }, { id: 2 }], limit: 5 })],
			[
				lookup({
					candidates: [{ id: 1 }],
					limit: 5,
					checks: ["min_score_reject"],
					picked: { id: 1, name: "a", source: "ranked" },
				}),
			]
		)

		expect(reading.relation).toBe("diverges")
		expect(reading.counts.unexplained).toBe(1)

		const account = reading.readings.find((entry) => entry.key === "locality:2")!

		expect(account.direction).toBe("removed")
		expect(account.reason).toContain("min_score_reject")
		expect(account.reason).toContain("pick ranked")
	})

	it("fails an unrelated expansion apart from ranking movement, naming the lookup and its mechanism", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1 }], limit: 5 })],
			[lookup({ candidates: [{ id: 1 }, { id: 7 }], limit: 5, checks: ["bare_race"] })]
		)

		expect(reading.relation).toBe("diverges")
		expect(reading.counts.unexplained).toBe(1)

		const account = reading.readings.find((entry) => entry.key === "locality:7")!

		expect(account.direction).toBe("added")
		expect(account.reason).toContain("no added constraint")
		expect(account.reason).toContain("bare_race")
		expect(reading.differences.join("\n")).toContain("locality|locality|springfield")
	})

	it("prefers the failure over the unmeasured reading when a row carries both", () => {
		const reading = accountRefinement(
			[
				lookup({ value: "Springfield", candidates: [{ id: 1 }, { id: 2 }, { id: 3 }], limit: 5 }),
				lookup({ value: "Chicago", candidates: [{ id: 10 }, { id: 11 }], limit: 5 }),
			],
			[
				lookup({ value: "Springfield", candidates: [{ id: 1 }], limit: 1 }),
				lookup({ value: "Chicago", candidates: [{ id: 10 }], limit: 5 }),
			]
		)

		expect(reading.relation).toBe("diverges")
		expect(reading.counts.unexplained).toBe(1)
		expect(reading.counts.beyond_window).toBeGreaterThan(0)
	})

	it("counts the lookups only one side performed, and reports a dropped one as a difference", () => {
		const reading = accountRefinement(
			[lookup({ value: "Köln", candidates: [{ id: 1 }] }), lookup({ value: "Nippes", candidates: [{ id: 2 }] })],
			[lookup({ value: "Köln", candidates: [{ id: 1 }] }), lookup({ value: "50733", candidates: [{ id: 3 }] })]
		)

		expect(reading.addedLookups).toEqual(["locality|locality|50733"])
		expect(reading.droppedLookups).toEqual(["locality|locality|nippes"])
		expect(reading.differences.join("\n")).toContain("performed no lookup for locality|locality|nippes")
		expect(reading.relation).toBe("refines")
	})

	it("is undecidable when the two runs share no lookup, and says how many each performed", () => {
		const reading = accountRefinement(
			[lookup({ value: "Köln", candidates: [{ id: 1 }] })],
			[lookup({ value: "Madrid", candidates: [{ id: 2 }] })]
		)

		expect(reading.relation).toBe("undecidable")
		expect(reading.pairedLookups).toBe(0)
		expect(reading.differences.join("\n")).toContain("no lookup ran on both sides")
	})

	it("is undecidable when neither run performed a lookup — an empty walk agrees about nothing", () => {
		expect(accountRefinement([], []).relation).toBe("undecidable")
	})

	it("states its basis whatever the verdict, naming every window it read", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1 }, { id: 2 }], limit: 2 })],
			[lookup({ candidates: [{ id: 1 }], limit: 5, country: "US" })]
		)

		expect(reading.basis).toContain("base 2/2 at window")
		expect(reading.basis).toContain("refined 1/5")
		expect(reading.basis).toContain("country=US")

		for (const account of CANDIDATE_ACCOUNTS) {
			expect(reading.basis, `basis omits the ${account} count`).toContain(`${account} `)
		}
	})

	it("keeps a candidate's identity namespaced by placetype — one gazetteer id, two bands", () => {
		const reading = accountRefinement(
			[lookup({ candidates: [{ id: 1, placetype: "locality" }], limit: 5 })],
			[lookup({ candidates: [{ id: 1, placetype: "localadmin" }], limit: 5 })]
		)

		expect(reading.counts.held).toBe(0)
		expect(reading.counts.unexplained).toBe(2)
	})
})
