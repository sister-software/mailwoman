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
		schemaVersion: 3,
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
			dataset: { id: null, sha256: null },
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
		provenance: { admitted: { minimum: ["verified_unseen", "unseen_by_candidate"], comparative: ["verified_unseen"] } },
		evaluations: {
			development: { id: null, description: "d" },
			confirmation: { id: null, description: "c" },
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
		published: i < published,
		candidate: i < candidate,
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
		expect(CURRENT_RELEASE_SPEC).toMatch(/release-requirements\.v6\.json$/u)

		const committed = validateReleaseSpec(
			await readLocalJSONFile<unknown>(new URL("specs/release-requirements.v6.json", import.meta.url).pathname)
		)

		const verdict = evaluate(committed, rowsFor("US", 50, 40, 45), {
			published: committed.identities.published.sha256!,
			candidate: CANDIDATE,
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
			rows.map((row) => ({ ...row, provenance: "unseen_by_candidate" as const }))

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

	it("reports the inference rule and refuses outcomes that record none", () => {
		const rows = [...rowsFor("US", 400, 300, 380), ...rowsFor("FR", 400, 300, 380)]
		const recorded = evaluate(baseSpec(), rows, artifacts)

		expect(recorded.inference).toEqual({ rule: "test rule", rowsByWeightsLocale: { "en-us": 800 } })

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
		const spec = baseSpec({ requirements: [], objective: { countries: ["US"], minimumImprovement: 0 } })
		const verdict = evaluate(spec, rowsFor("US", 20, 15, 15, grouped), artifacts)
		const objective = check(verdict, "objective")

		expect(objective.estimate).toBe(0)
		expect(objective.degenerateStrata).toEqual(["US"])
		expect(objective.upper! - objective.lower!).toBeGreaterThan(0)
		expect(objective.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("decides a degenerate difference once the sample is large", () => {
		const spec = baseSpec({ requirements: [], objective: { countries: ["US"], minimumImprovement: -0.05 } })
		const verdict = evaluate(spec, rowsFor("US", 4000, 3000, 3000, grouped), artifacts)
		const objective = check(verdict, "objective")

		expect(objective.degenerateStrata).toEqual(["US"])
		expect(objective.lower!).toBeGreaterThanOrEqual(-0.05)
		expect(objective.outcome).toBe(ReleaseOutcome.Pass)
	})

	it("reports a stratum of one unit as insufficient rather than zero width", () => {
		const spec = baseSpec({ requirements: [], objective: { countries: ["US"], minimumImprovement: -0.5 } })

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
		const spec = baseSpec({ objective: { countries: ["US"], minimumImprovement: -1 } })
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
		expect(() => pairOutcomes([row("a", true)], [{ ...row("a", true), exact: "yes" as never }])).toThrow(/unreadable/u)
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
