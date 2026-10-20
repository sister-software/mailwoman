import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { describe, expect, it } from "vitest"

import {
	evaluateReleaseSpec,
	groupedResampler,
	type OutcomeRow,
	type PairedRow,
	pairOutcomes,
	ReleaseOutcome,
} from "#tools/eval-harness/release/evaluate"
import { type ReleaseRequirementSpec, validateReleaseSpec } from "#tools/eval-harness/release/requirements"

const PUBLISHED = "a".repeat(64)
const CANDIDATE = "b".repeat(64)
const artifacts = { published: PUBLISHED, candidate: CANDIDATE }

const baseSpec = (overrides: Partial<ReleaseRequirementSpec> = {}): ReleaseRequirementSpec =>
	validateReleaseSpec({
		schemaVersion: 1,
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
			groupingAssumption: "test",
			resamples: 500,
			seed: 1,
			requiredPrecision: null,
		},
		provenance: { admitted: ["verified_unseen"] },
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

		const verdict = evaluateReleaseSpec(
			spec,
			[...rowsFor("US", 200, 180, 200), ...rowsFor("FR", 200, 180, 200)],
			artifacts
		)

		expect(check(verdict, "us").outcome).toBe(ReleaseOutcome.Insufficient)
		expect(check(verdict, "us").reasons).toContain("threshold unregistered")
		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("reads the committed first specification as insufficient evidence", async () => {
		const committed = validateReleaseSpec(
			await readLocalJSONFile<unknown>(new URL("specs/release-requirements.v1.json", import.meta.url).pathname)
		)

		const verdict = evaluateReleaseSpec(committed, rowsFor("US", 50, 40, 45), artifacts)

		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("passes when every lower bound clears its threshold", () => {
		const verdict = evaluateReleaseSpec(
			baseSpec(),
			[...rowsFor("US", 400, 300, 380), ...rowsFor("FR", 400, 300, 380)],
			artifacts
		)

		expect(verdict.checks.map((c) => c.outcome)).toEqual([ReleaseOutcome.Pass, ReleaseOutcome.Pass])
		expect(verdict.outcome).toBe(ReleaseOutcome.Pass)
	})

	it("fails when the upper bound is below a minimum", () => {
		const verdict = evaluateReleaseSpec(
			baseSpec(),
			[...rowsFor("US", 400, 100, 100), ...rowsFor("FR", 400, 300, 380)],
			artifacts
		)

		expect(check(verdict, "us").outcome).toBe(ReleaseOutcome.Fail)
		expect(verdict.outcome).toBe(ReleaseOutcome.Fail)
	})

	it("reports insufficient evidence when an interval crosses the threshold", () => {
		const verdict = evaluateReleaseSpec(
			baseSpec(),
			[...rowsFor("US", 20, 10, 11), ...rowsFor("FR", 400, 300, 380)],
			artifacts
		)

		const us = check(verdict, "us")

		expect(us.lower!).toBeLessThan(0.5)
		expect(us.upper!).toBeGreaterThanOrEqual(0.5)
		expect(us.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("reports insufficient evidence for a required country without rows", () => {
		const verdict = evaluateReleaseSpec(baseSpec(), rowsFor("FR", 400, 300, 380), artifacts)

		expect(check(verdict, "us").reasons).toContain("required country US has no admitted rows")
		expect(check(verdict, "objective").outcome).toBe(ReleaseOutcome.Insufficient)
		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
	})

	it("weights each objective country equally regardless of row count", () => {
		const verdict = evaluateReleaseSpec(
			baseSpec(),
			// US gains 0.1 on 2000 rows; FR loses 0.4 on 50 rows.
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

		const verdict = evaluateReleaseSpec(baseSpec(), rows, artifacts)

		expect(verdict.outcome).toBe(ReleaseOutcome.Insufficient)
		expect(verdict.provenance.find((p) => p.provenance === "unknown")).toMatchObject({ admitted: false, rows: 800 })
	})

	it("is deterministic for a seed", () => {
		const rows = [...rowsFor("US", 60, 30, 40), ...rowsFor("FR", 60, 30, 40)]

		expect(evaluateReleaseSpec(baseSpec(), rows, artifacts)).toEqual(evaluateReleaseSpec(baseSpec(), rows, artifacts))
	})

	it("refuses an artifact whose hash differs from the registered identity", () => {
		expect(() =>
			evaluateReleaseSpec(baseSpec(), rowsFor("US", 10, 5, 5), {
				published: PUBLISHED,
				candidate: "c".repeat(64),
			})
		).toThrow(/candidate artifact sha256/u)
	})
})

describe("groupedResampler", () => {
	it("draws a group's rows together", () => {
		const rows = rowsFor("US", 30, 10, 10, (i) => `g${Math.floor(i / 3)}`)
		const { draw, groups } = groupedResampler(rows, 7)

		expect(groups.get("US")).toBe(10)

		for (let r = 0; r < 50; r++) {
			const weights = draw()

			for (let g = 0; g < 10; g++) {
				expect(new Set([weights[3 * g], weights[3 * g + 1], weights[3 * g + 2]]).size).toBe(1)
			}

			expect(weights.reduce((a, b) => a + b, 0)).toBe(30)
		}
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
})
