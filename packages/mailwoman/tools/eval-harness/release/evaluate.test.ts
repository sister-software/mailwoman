// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { describe, expect, it } from "vitest"

import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import {
	evaluateReleaseSpec,
	type OutcomeRow,
	type PairedRow,
	pairOutcomes,
	ReleaseOutcome,
} from "#tools/eval-harness/release/evaluate"
import { type ReleaseRequirementSpec, validateReleaseSpec } from "#tools/eval-harness/release/requirements"

const PUBLISHED = "a".repeat(64)
const CANDIDATE = "b".repeat(64)
const artifacts = { published: PUBLISHED, candidate: CANDIDATE }
const INFERENCE = { rule: "test rule" }

const evaluate = (
	spec: ReleaseRequirementSpec,
	rows: readonly PairedRow[],
	measured: { published: string; candidate: string },
	inference: { rule: string | null } = INFERENCE
) => evaluateReleaseSpec(spec, rows, measured, inference)

const baseSpec = (overrides: Partial<ReleaseRequirementSpec> = {}): ReleaseRequirementSpec =>
	validateReleaseSpec({
		schemaVersion: 4,
		specVersion: "test",
		rationale: "test",
		requirements: [
			{
				id: "us",
				kind: "country",
				country: "US",
				reason: "test",
				minimum: 0.5,
			},
		],
		objective: { countries: ["US", "FR"], minimumImprovement: 0 },
		identities: {
			dataset: [{ id: "heldout-confirm-test@0123456789abcdef", sha256: "c".repeat(64) }],
			scorer: { id: "exact-parse", revision: "test" },
			inference: { description: "test", options: {} },
			published: { description: "p", sha256: PUBLISHED },
			candidate: { description: "c", sha256: CANDIDATE },
		},
		statistics: {
			confidenceLevel: 0.95,
			multipleComparison: "bonferroni",
			samplingUnit: "group",
			rowsIndependent: true,
			groupingAssumption: "test",
			requiredPrecision: null,
		},
		provenance: {
			admitted: {
				minimum: ["verified_unseen", "unseen_by_candidate"],
				comparative: ["verified_unseen"],
			},
		},
		evaluations: {
			development: { ids: ["heldout-dev-test@0123456789abcdef"], description: "d" },
			confirmation: { ids: ["heldout-confirm-test@0123456789abcdef"], description: "c" },
		},
		...overrides,
	})

/**
 * `n` rows of one country with the given published and candidate exact counts.
 */
const rowsFor = (country: string, n: number, published: number, candidate: number, group?: (i: number) => string) =>
	Array.from({ length: n }, (_, i): PairedRow => ({
		rowID: `${country}:${i}`,
		country,
		source: `oa-${country.toLowerCase()}`,
		kind: "address",
		provenance: "verified_unseen",
		group: group ? group(i) : null,
		weightsLocale: "en-us",
		tags: ["house_number", "street"],
		published: i < published,
		candidate: i < candidate,
		geocode: null,
	}))

/**
 * Rows whose parse outcomes are equal in both arms and whose geocode outcomes differ as given.
 */
const geocodedFor = (country: string, n: number, published: number, candidate: number) =>
	rowsFor(country, n, n, n, (i) => `g${i}`).map((row, i) => ({
		...row,
		geocode: { published: i < published, candidate: i < candidate },
	}))

const check = (verdict: ReturnType<typeof evaluateReleaseSpec>, id: string) => verdict.checks.find((c) => c.id === id)!

describe("evaluateReleaseSpec", () => {
	it("reports insufficient evidence when a threshold is unregistered", () => {
		const spec = baseSpec({
			requirements: [
				{
					id: "us",
					kind: "country",
					country: "US",
					reason: "t",
					minimum: null,
				},
			],
		})

		const verdict = evaluate(spec, [...rowsFor("US", 200, 180, 200), ...rowsFor("FR", 200, 180, 200)], artifacts)

		expect(check(verdict, "us").outcome).toBe(ReleaseOutcome.Insufficient)
		expect(check(verdict, "us").reasons).toContain("threshold unregistered")
		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("reads the current specification as insufficient evidence when required countries have no rows", async () => {
		const committed = validateReleaseSpec(await readLocalJSONFile<unknown>(CURRENT_RELEASE_SPEC))

		const verdict = evaluate(committed, rowsFor("US", 50, 40, 45), {
			published: committed.identities.published.sha256!,
			candidate: committed.identities.candidate.sha256 ?? CANDIDATE,
		})

		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("passes when every lower bound clears its threshold", () => {
		const verdict = evaluate(baseSpec(), [...rowsFor("US", 400, 300, 380), ...rowsFor("FR", 400, 300, 380)], artifacts)

		expect(verdict.checks.map((c) => c.outcome)).toEqual([ReleaseOutcome.Pass, ReleaseOutcome.Pass])
		expect(verdict.outcome).toBe(ReleaseOutcome.Pass)
	})

	it("fails when the upper bound is below a minimum", () => {
		const verdict = evaluate(baseSpec(), [...rowsFor("US", 400, 100, 100), ...rowsFor("FR", 400, 300, 380)], artifacts)

		expect(check(verdict, "us").outcome).toBe(ReleaseOutcome.Fail)
		expect(verdict.outcome).toBe(ReleaseOutcome.Fail)
	})

	it("reports insufficient evidence when an interval crosses the threshold", () => {
		const verdict = evaluate(baseSpec(), [...rowsFor("US", 20, 10, 11), ...rowsFor("FR", 400, 300, 380)], artifacts)

		const us = check(verdict, "us")

		expect(us.lower!).toBeLessThan(0.5)
		expect(us.upper!).toBeGreaterThanOrEqual(0.5)
		expect(us.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("reports insufficient evidence for a required country without rows", () => {
		const verdict = evaluate(baseSpec(), rowsFor("FR", 400, 300, 380), artifacts)

		expect(check(verdict, "us").reasons).toContain("required country US has no admitted rows")
		expect(check(verdict, "objective").outcome).toBe(ReleaseOutcome.Insufficient)
		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("weights each objective country equally regardless of row count", () => {
		const verdict = evaluate(
			baseSpec(),
			// US gains 0.1 on 2000 rows.
			// FR loses 0.4 on 50 rows.
			// Row-weighted the change is positive.
			[...rowsFor("US", 2000, 1600, 1800), ...rowsFor("FR", 50, 40, 20)],
			artifacts
		)

		expect(check(verdict, "objective").estimate).toBeCloseTo((0.1 - 0.4) / 2, 10)
		expect(check(verdict, "objective").outcome).toBe(ReleaseOutcome.Fail)
	})

	it("leaves a capability probe's rows out of country checks and the objective, and scores them under the capability", () => {
		const spec = baseSpec({
			requirements: [
				...baseSpec().requirements,
				{
					id: "postal_unit",
					kind: "capability",
					task: "test",
					metric: "exact_parse",
					reason: "test",
					minimum: 0.5,
					select: {
						kinds: ["address"],
						sources: ["invented-postal-unit-guideline"],
					},
				},
			],
		})

		const probe = rowsFor("US", 100, 0, 0).map((row) => ({
			...row,
			rowID: `probe:${row.rowID}`,
			source: "invented-postal-unit-guideline",
		}))

		const ordinary = [...rowsFor("US", 200, 150, 150), ...rowsFor("FR", 200, 150, 150)]
		const verdict = evaluate(spec, [...ordinary, ...probe], artifacts)
		const us = verdict.checks.find((c) => c.id === "us" && c.check === "minimum")!

		expect(us.rows).toBe(200)
		expect(us.estimate).toBeCloseTo(0.75, 10)
		expect(check(verdict, "objective").rows).toBe(400)
		expect(verdict.checks.find((c) => c.id === "postal_unit")!.rows).toBe(100)

		const verified = verdict.provenance.find((c) => c.provenance === "verified_unseen")!

		expect(verified.rows).toBe(400)
	})

	it("admits only the provenance classes the specification names and reports every class", () => {
		const rows = [...rowsFor("US", 400, 300, 380), ...rowsFor("FR", 400, 300, 380)].map((row) => ({
			...row,
			provenance: "unknown" as const,
		}))

		const verdict = evaluate(baseSpec(), rows, artifacts)

		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)

		expect(verdict.provenance.find((p) => p.provenance === "unknown")).toMatchObject({
			admitted: { minimum: false, comparative: false },
			rows: 800,
		})
	})

	it("lets minimum checks read rows unseen by the candidate while comparative checks read only rows unseen by both", () => {
		const unseenByCandidate = (rows: PairedRow[]) =>
			rows.map((row) => ({
				...row,
				provenance: "unseen_by_candidate" as const,
			}))

		const spec = baseSpec({
			requirements: [
				{ id: "us", kind: "country", country: "US", reason: "t", minimum: 0.5 },
				{
					id: "cap",
					kind: "capability",
					task: "t",
					metric: "exact_parse",
					reason: "t",
					minimum: 0.5,
					maxLoss: 0.05,
					maxLossReason: "t",
					select: { countries: ["US"] },
				},
			],
		})

		// US rows were in the published model's training data only.
		// FR rows are unseen by both.
		const verdict = evaluate(
			spec,
			[...unseenByCandidate(rowsFor("US", 400, 390, 380)), ...rowsFor("FR", 400, 300, 380)],
			artifacts
		)

		expect(verdict.checks.find((c) => c.id === "us" && c.check === "minimum")).toMatchObject({
			rows: 400,
			outcome: ReleaseOutcome.Pass,
		})

		expect(verdict.checks.find((c) => c.id === "cap" && c.check === "max_loss")).toMatchObject({
			rows: 0,
			outcome: ReleaseOutcome.Insufficient,
		})

		const objective = check(verdict, "objective")

		expect(objective.rows).toBe(400)
		expect(objective.reasons).toContain("required country US has no admitted rows")

		expect(verdict.provenance.find((p) => p.provenance === "unseen_by_candidate")).toMatchObject({
			admitted: { minimum: true, comparative: false },
			rows: 400,
		})
	})

	it("judges a capability without a minimum by its no-loss bound alone", () => {
		const lossOnly = (maxLoss: number) =>
			baseSpec({
				requirements: [
					{
						id: "cap",
						kind: "capability",
						task: "t",
						metric: "exact_parse",
						reason: "t",
						maxLoss,
						maxLossReason: "t",
						select: { countries: ["US"] },
					},
				],
			})

		// The published model reads 0.70, under a 0.85 minimum, and the candidate repairs it.
		const repaired = rowsFor("US", 1000, 700, 820, (i) => `g${i}`)
		const verdict = evaluate(lossOnly(0), [...repaired, ...rowsFor("FR", 400, 300, 300)], artifacts)
		const checks = verdict.checks.filter((c) => c.id === "cap")

		expect(checks.map((c) => c.check)).toEqual(["max_loss"])
		expect(checks[0]!.outcome).toBe(ReleaseOutcome.Pass)
		expect(checks[0]!.estimate).toBeCloseTo(0.12)

		// An arm that loses on the capability fails, however high its rate.
		const lost = rowsFor("US", 1000, 950, 900, (i) => `g${i}`)

		expect(check(evaluate(lossOnly(0), lost, artifacts), "cap").outcome).toBe(ReleaseOutcome.Fail)

		expect(() =>
			baseSpec({
				requirements: [
					{
						id: "cap",
						kind: "capability",
						task: "t",
						metric: "exact_parse",
						reason: "t",
						select: { countries: ["US"] },
					},
				],
			})
		).toThrow(/may be omitted only beside a registered maxLoss/u)
	})

	it("reports the inference rule and refuses outcomes that record none", () => {
		const rows = [...rowsFor("US", 400, 300, 380), ...rowsFor("FR", 400, 300, 380)]
		const recorded = evaluate(baseSpec(), rows, artifacts)

		expect(recorded.inference).toEqual({
			rule: "test rule",
			rowsByWeightsLocale: { "en-us": 800 },
		})

		const unrecorded = evaluate(baseSpec(), rows, artifacts, { rule: null })

		expect(unrecorded.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(unrecorded.reasons.join(" ")).toMatch(/no inference rule/u)

		const noLocale = evaluate(
			baseSpec(),
			rows.map((row) => ({ ...row, weightsLocale: null })),
			artifacts
		)

		expect(noLocale.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(noLocale.inference.rowsByWeightsLocale).toEqual({ unrecorded: 800 })
	})

	it("fails a candidate whose vocabulary leaves an edge inside a piece, and withholds pass without a census", () => {
		const spec = baseSpec({
			vocabulary: { maximumUnreachableEdges: 0, reason: "test" },
		})

		const rows = [...rowsFor("US", 400, 300, 380), ...rowsFor("FR", 400, 300, 380)]

		const census = (unreachableAtClassChange: number) => ({
			tokenizer: "c6.model",
			unreachableAtClassChange,
		})

		expect(evaluateReleaseSpec(spec, rows, artifacts, INFERENCE, census(0)).outcome).toBe(ReleaseOutcome.Pass)
		expect(evaluateReleaseSpec(spec, rows, artifacts, INFERENCE, census(3)).outcome).toBe(ReleaseOutcome.Fail)
		expect(evaluateReleaseSpec(spec, rows, artifacts, INFERENCE).outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("refuses a vocabulary limit that is not a non-negative integer", () => {
		expect(() =>
			baseSpec({
				vocabulary: { maximumUnreachableEdges: 0.5, reason: "test" },
			})
		).toThrow(/maximumUnreachableEdges/u)
	})

	it("leaves a row whose expected spans hold a withoutTags tag out of a capability", () => {
		const spec = baseSpec({
			requirements: [
				{
					id: "postal_unit",
					kind: "capability",
					task: "t",
					metric: "exact_parse",
					reason: "t",
					minimum: 0.5,
					select: { kinds: ["address"], sources: ["invented-postal-unit-guideline"], withoutTags: ["venue"] },
				},
			],
		})

		const probe = (tags: string[]) =>
			rowsFor("FR", 50, 0, 0, (i) => `${tags.join("+")}${i}`).map((row) => ({
				...row,
				rowID: `${tags.join("+")}:${row.rowID}`,
				source: "invented-postal-unit-guideline",
				tags,
			}))

		const rows = [...probe(["unit", "street"]), ...probe(["venue", "street"]), ...rowsFor("US", 50, 40, 40)]
		const capability = check(evaluate(spec, rows, artifacts), "postal_unit")

		expect(capability.rows).toBe(50)

		expect(() =>
			evaluate(
				spec,
				rows.map((row) => ({ ...row, tags: null })),
				artifacts
			)
		).toThrow(/records no expected tags/u)
	})

	it("bounds a geocode requirement's loss on the geocode outcomes, which a parse-only change leaves equal", () => {
		const spec = baseSpec({
			requirements: [
				{
					id: "geocode",
					kind: "geocode",
					task: "t",
					metric: "geocode_outcome",
					reason: "t",
					countries: ["US", "FR"],
					select: { kinds: ["address"] },
					maxLoss: 0.01,
					maxLossReason: "t",
					sameModelAdmitted: ["verified_unseen", "known_overlap"],
				},
			],
		})

		// The parse outcomes are equal.
		// The candidate's geocode fixes 40 US rows and loses none.
		const fixed = evaluate(
			spec,
			[...geocodedFor("US", 2000, 1500, 1540), ...geocodedFor("FR", 2000, 1800, 1800)],
			artifacts
		)

		const geocode = check(fixed, "geocode")

		expect(geocode.check).toBe("max_loss")
		expect(geocode.estimate).toBeCloseTo(40 / 2000 / 2, 10)
		expect(geocode.outcome).toBe(ReleaseOutcome.Pass)

		const lost = check(
			evaluate(spec, [...geocodedFor("US", 2000, 1500, 1300), ...geocodedFor("FR", 2000, 1800, 1800)], artifacts),
			"geocode"
		)

		expect(lost.outcome).toBe(ReleaseOutcome.Fail)
	})

	it("reads a geocode requirement's same-model classes when both arms carry one model, and the comparative ones otherwise", () => {
		const requirement = {
			id: "geocode",
			kind: "geocode" as const,
			task: "t",
			metric: "geocode_outcome" as const,
			reason: "t",
			countries: ["US"],
			maxLoss: 0.01,
			maxLossReason: "t",
			sameModelAdmitted: ["verified_unseen" as const, "known_overlap" as const],
		}

		const oneModel = baseSpec({
			requirements: [requirement],
			identities: { ...baseSpec().identities, candidate: { description: "c", sha256: PUBLISHED } },
		})

		// The resolver change fixes 40 rows the model trained on.
		const rows = geocodedFor("US", 2000, 1500, 1540).map((row, i) => ({
			...row,
			provenance: i < 1000 ? ("verified_unseen" as const) : ("known_overlap" as const),
		}))

		const same = check(evaluate(oneModel, rows, { published: PUBLISHED, candidate: PUBLISHED }), "geocode")

		expect(same.admitted).toEqual(["verified_unseen", "known_overlap"])
		expect(same.rows).toBe(2000)
		expect(same.estimate).toBeCloseTo(40 / 2000, 10)

		const different = check(evaluate(baseSpec({ requirements: [requirement] }), rows, artifacts), "geocode")

		expect(different.admitted).toEqual(["verified_unseen"])
		expect(different.rows).toBe(1000)
		expect(different.estimate).toBe(0)
	})

	it("reports a geocode requirement insufficient when a selected row carries no geocode outcome", () => {
		const spec = baseSpec({
			requirements: [
				{
					id: "geocode",
					kind: "geocode",
					task: "t",
					metric: "geocode_outcome",
					reason: "t",
					countries: ["US"],
					maxLoss: 0.01,
					maxLossReason: "t",
					sameModelAdmitted: ["verified_unseen"],
				},
			],
		})

		const rows = [
			...geocodedFor("US", 2000, 1500, 1500),
			...rowsFor("US", 10, 5, 5).map((r) => ({ ...r, rowID: `x${r.rowID}` })),
		]

		const geocode = check(evaluate(spec, rows, artifacts), "geocode")

		expect(geocode.rows).toBe(2000)
		expect(geocode.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(geocode.reasons.join(" ")).toMatch(/10 of 2010 selected rows carry no geocode outcome/u)

		const none = check(evaluate(spec, rowsFor("US", 100, 50, 50), artifacts), "geocode")

		expect(none.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(none.reasons).toContain("required country US has no admitted rows")
	})

	it("makes a verdict insufficient when the collections make up no evaluation role", () => {
		const rows = [...rowsFor("US", 400, 300, 380), ...rowsFor("FR", 400, 300, 380)]

		const verdict = evaluateReleaseSpec(baseSpec(), rows, artifacts, INFERENCE, null, ["the report lacks a collection"])

		expect(verdict.checks.every((c) => c.outcome === ReleaseOutcome.Pass)).toBe(true)
		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(verdict.reasons).toContain("the report lacks a collection")
	})

	it("is deterministic", () => {
		const rows = [...rowsFor("US", 60, 30, 40), ...rowsFor("FR", 60, 30, 40)]

		expect(evaluate(baseSpec(), rows, artifacts)).toEqual(evaluate(baseSpec(), rows, artifacts))
	})

	it("refuses an artifact whose hash differs from the registered identity", () => {
		expect(() =>
			evaluate(baseSpec(), rowsFor("US", 10, 5, 5), {
				published: PUBLISHED,
				candidate: "c".repeat(64),
			})
		).toThrow(/candidate artifact sha256/u)
	})
})

describe("small and degenerate samples", () => {
	const grouped = (i: number) => `g${i}`

	it("does not pass a small sample in which every row is exact", () => {
		const spec = baseSpec({
			requirements: [{ id: "us", kind: "country", country: "US", reason: "t", minimum: 0.9 }],
			objective: { countries: ["US"], minimumImprovement: -0.05 },
		})

		const verdict = evaluate(spec, rowsFor("US", 10, 10, 10, grouped), artifacts)
		const us = check(verdict, "us")

		expect(us.estimate).toBe(1)
		expect(us.upper).toBe(1)
		// 10 of 10 at a per-side tail of 0.0125: the exact lower bound is 0.0125^(1/10).
		expect(us.lower!).toBeCloseTo(0.0125 ** (1 / 10), 6)
		expect(us.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(verdict.outcome).not.toBe(ReleaseOutcome.Pass)
	})

	it("gives a sample with no discordant pair a non-zero width and does not pass it", () => {
		const spec = baseSpec({
			requirements: [],
			objective: { countries: ["US"], minimumImprovement: 0 },
		})

		const verdict = evaluate(spec, rowsFor("US", 20, 15, 15, grouped), artifacts)
		const objective = check(verdict, "objective")

		expect(objective.estimate).toBe(0)
		expect(objective.degenerateStrata).toEqual(["US"])
		expect(objective.upper! - objective.lower!).toBeGreaterThan(0)
		expect(objective.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("decides a degenerate difference once the sample is large", () => {
		const spec = baseSpec({
			requirements: [],
			objective: { countries: ["US"], minimumImprovement: -0.05 },
		})

		const verdict = evaluate(spec, rowsFor("US", 4000, 3000, 3000, grouped), artifacts)
		const objective = check(verdict, "objective")

		expect(objective.degenerateStrata).toEqual(["US"])
		expect(objective.lower!).toBeGreaterThanOrEqual(-0.05)
		expect(objective.outcome).toBe(ReleaseOutcome.Pass)
	})

	it("reports a stratum of one unit as insufficient rather than zero width", () => {
		const spec = baseSpec({
			requirements: [],
			objective: { countries: ["US"], minimumImprovement: -0.5 },
		})

		const verdict = evaluate(
			spec,
			rowsFor("US", 5, 5, 5, () => "one"),
			artifacts
		)

		const objective = check(verdict, "objective")

		expect(objective.lower).toBeNull()
		expect(objective.reasons.join(" ")).toMatch(/fewer than two independent units/u)
		expect(objective.outcome).toBe(ReleaseOutcome.Insufficient)
	})
})

describe("grouping", () => {
	const notIndependent = (spec: ReleaseRequirementSpec): ReleaseRequirementSpec => ({
		...spec,
		statistics: { ...spec.statistics, rowsIndependent: false },
	})

	it("reports insufficient evidence for ungrouped rows when rows are not declared independent", () => {
		const verdict = evaluate(
			notIndependent(baseSpec()),
			[...rowsFor("US", 400, 300, 380), ...rowsFor("FR", 400, 300, 380)],
			artifacts
		)

		for (const c of verdict.checks) {
			expect(c.outcome).toBe(ReleaseOutcome.Insufficient)
			expect(c.lower).toBeNull()
			expect(c.reasons.join(" ")).toMatch(/400 of 400 rows carry no group|800 of 800 rows carry no group/u)
		}

		expect(verdict.statistics.rowsIndependent).toBe(false)
		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("decides grouped rows when rows are not declared independent", () => {
		const verdict = evaluate(
			notIndependent(baseSpec()),
			[...rowsFor("US", 400, 300, 380, (i) => `g${i}`), ...rowsFor("FR", 400, 300, 380, (i) => `g${i}`)],
			artifacts
		)

		expect(verdict.outcome).toBe(ReleaseOutcome.Pass)
	})

	it("widens a rate's bounds when variants share a group", () => {
		// Groups of five identical rows: 400 rows make 80 independent units.
		const rows = rowsFor("US", 400, 300, 300, (i) => `g${Math.floor(i / 5)}`)

		const spec = baseSpec({
			objective: { countries: ["US"], minimumImprovement: -1 },
		})

		const groupedUS = check(evaluate(notIndependent(spec), rows, artifacts), "us")

		const independentUS = check(
			evaluate(
				spec,
				rows.map((row) => ({ ...row, group: null })),
				artifacts
			),
			"us"
		)

		expect(groupedUS.effectiveRows!).toBeCloseTo(80, 6)
		expect(independentUS.effectiveRows).toBe(400)
		expect(groupedUS.upper! - groupedUS.lower!).toBeGreaterThan(independentUS.upper! - independentUS.lower!)
	})
})

describe("pairOutcomes", () => {
	const row = (rowID: string, exact: boolean): OutcomeRow => ({
		rowID,
		country: "US",
		source: "oa-us",
		kind: "address",
		provenance: "unknown",
		exact,
	})

	it("refuses arms whose rows differ", () => {
		expect(() => pairOutcomes([row("a", true)], [row("b", true)])).toThrow(/row 0/u)
		expect(() => pairOutcomes([row("a", true)], [])).toThrow(/1 rows/u)
	})

	it("refuses an unreadable outcome", () => {
		// An outcome read from disk preserves the file's value.
		// The row type cannot express every such value.
		const unreadable = row("a", true)

		Reflect.set(unreadable, "exact", "yes")

		expect(() => pairOutcomes([row("a", true)], [unreadable])).toThrow(/unreadable/u)
	})

	it("carries each arm's geocode outcome and refuses a row geocoded in one arm only", () => {
		const paired = pairOutcomes(
			[{ ...row("a", true), geocode: { exact: false } }],
			[{ ...row("a", true), geocode: { exact: true } }]
		)

		expect(paired[0]).toMatchObject({
			published: true,
			candidate: true,
			geocode: { published: false, candidate: true },
		})

		expect(() => pairOutcomes([{ ...row("a", true), geocode: { exact: true } }], [row("a", true)])).toThrow(
			/geocode outcome in one arm only/u
		)
	})

	it("carries the weights locale and refuses arms parsed by different packages", () => {
		expect(
			pairOutcomes([{ ...row("a", true), weightsLocale: "en-gb" }], [{ ...row("a", false), weightsLocale: "en-gb" }])[0]
		).toMatchObject({ weightsLocale: "en-gb" })

		expect(() =>
			pairOutcomes([{ ...row("a", true), weightsLocale: "en-gb" }], [{ ...row("a", true), weightsLocale: "en-us" }])
		).toThrow(/different weights locale packages/u)
	})
})
