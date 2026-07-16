/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the harness baseline assertion (#727 stage-2, Tier 0).
 *
 *   The two incidents this mechanism exists for are replayed verbatim as tests — Phase 1's
 *   token@1 0.348 against a v264 known-good of 0.573, and Phase 4a's dark resolver reading 0.000
 *   street evidence. If either ever passes, the mechanism is decorative.
 */

import { describe, expect, it } from "vitest"

import {
	assertBaselines,
	assertProfile,
	findBaseline,
	formatVerdict,
	guardReport,
	listBaselines,
	listProfiles,
	resolveProfile,
} from "./baseline-assert.ts"

describe("baseline registry", () => {
	it("loads every registered row", () => {
		expect(listBaselines().length).toBeGreaterThan(0)
	})

	it("demands a reproducible provenance on every row", () => {
		// A baseline you can't reproduce from its own row is a rumor.
		for (const baseline of listBaselines()) {
			expect(baseline.commit, `${baseline.id} has no commit`).toBeTruthy()
			expect(baseline.command, `${baseline.id} has no command`).toBeTruthy()
			expect(baseline.note, `${baseline.id} has no note`).toBeTruthy()
			expect(baseline.registered_at, `${baseline.id} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		}
	})

	it("carries an absolute tolerance on any zero-valued row", () => {
		// Relative deviation is undefined at zero — such a row would silently never fire.
		for (const baseline of listBaselines()) {
			if (baseline.value === 0) {
				expect(baseline.tolerance_abs, `${baseline.id} is zero-valued with no tolerance_abs`).toBeGreaterThan(0)
			}
		}
	})

	it("has unique ids", () => {
		const ids = listBaselines().map((b) => b.id)

		expect(new Set(ids).size).toBe(ids.length)
	})
})

describe("assertBaselines", () => {
	it("passes a reading on its baseline", () => {
		const verdict = assertBaselines([{ id: "parity.street.token_at_1@v264", observed: 0.573 }])

		expect(verdict.ok).toBe(true)
		expect(verdict.checked).toBe(1)
	})

	it("passes a reading inside tolerance", () => {
		// 0.573 -> 0.60 is +4.7%, under the 10% default.
		const verdict = assertBaselines([{ id: "parity.street.token_at_1@v264", observed: 0.6 }])

		expect(verdict.ok).toBe(true)
	})

	it("REFUSES the Phase 1 incident — token@1 0.348 against a 0.573 baseline", () => {
		const verdict = assertBaselines([{ id: "parity.street.token_at_1@v264", observed: 0.348 }])

		expect(verdict.ok).toBe(false)
		expect(verdict.violations[0]!.kind).toBe("deviation")
		expect(verdict.violations[0]!.deviationRel).toBeLessThan(-0.35)
	})

	it("REFUSES the Phase 4a incident — a dark resolver reading 0.000 street evidence", () => {
		const verdict = assertBaselines([{ id: "paris.resolver.street_evidence_rate@ban-street-centroids", observed: 0 }])

		expect(verdict.ok).toBe(false)
		expect(verdict.violations[0]!.kind).toBe("deviation")
	})

	it("is TWO-SIDED — a metric far ABOVE its baseline refuses too", () => {
		// The usual cause of a jump is that the number changed meaning, not that the model improved.
		const verdict = assertBaselines([{ id: "parity.street.token_at_1@v264", observed: 0.95 }])

		expect(verdict.ok).toBe(false)
		expect(verdict.violations[0]!.deviationRel).toBeGreaterThan(0)
	})

	it("refuses an unregistered id rather than passing it", () => {
		// An unverifiable reading is exactly the state both incidents were in.
		const verdict = assertBaselines([{ id: "nope.not.a.baseline@v999", observed: 0.5 }])

		expect(verdict.ok).toBe(false)
		expect(verdict.violations[0]!.kind).toBe("unregistered")
	})

	it("reports every violation, not just the first", () => {
		const verdict = assertBaselines([
			{ id: "parity.street.token_at_1@v264", observed: 0.348 },
			{ id: "parity.street.oracle_at_10@v264-summed-bio", observed: 0.749 },
			{ id: "nope.not.a.baseline@v999", observed: 0.5 },
		])

		expect(verdict.violations).toHaveLength(2)
		expect(verdict.checked).toBe(3)
	})

	it("honours a row's absolute tolerance", () => {
		const baseline = findBaseline("paris.resolver.street_evidence_rate@ban-street-centroids")!

		expect(baseline.tolerance_abs).toBe(0.01)
		// 0.016 -> 0.02 is inside the absolute band even though it is +25% relative.
		expect(assertBaselines([{ id: baseline.id, observed: 0.02 }]).ok).toBe(true)
		expect(assertBaselines([{ id: baseline.id, observed: 0.05 }]).ok).toBe(false)
	})
})

describe("profiles", () => {
	it("registers the arc's two models", () => {
		expect(listProfiles()).toEqual(expect.arrayContaining(["v264", "v301"]))
	})

	it("maps every profile metric to a baseline that exists", () => {
		// A profile pointing at a missing row would check nothing while looking like it checked.
		for (const name of listProfiles()) {
			for (const [metricKey, id] of Object.entries(resolveProfile(name).observe)) {
				expect(findBaseline(id), `profile ${name}.${metricKey} -> unknown baseline ${id}`).toBeDefined()
			}
		}
	})

	it("never mixes harnesses within one profile", () => {
		// The bug this file shipped with on 2026-07-16: oracle-k's `v301` profile pointed its seg@1
		// reading at a LEARNED-span-decode row (0.5768) while oracle-k computes the summed-BIO
		// stand-in (0.449) — two harnesses compared through one id, refusing on a healthy run.
		// Caught by running it, not by reading it. This test reads it.
		//
		// The token@1 row is the one legitimate crossover: every JS harness computes the same BIO
		// argmax, so `js-ship-config` is shared. Anything else must be single-harness.
		for (const name of listProfiles()) {
			const harnesses = new Set(
				Object.values(resolveProfile(name).observe)
					.map((id) => findBaseline(id)!.harness)
					.filter((harness) => harness !== "js-ship-config")
			)

			expect([...harnesses], `profile ${name} spans harnesses ${[...harnesses].join(" + ")}`).toHaveLength(
				harnesses.size > 0 ? 1 : 0
			)
		}
	})

	it("keeps the summed-BIO stand-in and the learned span decode on separate ids", () => {
		// They are different numbers on the same weights — 0.449 vs 0.5768 on v301. If a future edit
		// collapses them, every span-head claim becomes uninterpretable.
		const standIn = findBaseline("parity.street.seg_at_1@v301-summed-bio")!
		const learned = findBaseline("parity.street.seg_at_1@v301-span")!

		expect(standIn.harness).toBe("js-summed-bio-segdecode")
		expect(learned.harness).toBe("js-span-decode")
		expect(standIn.value).not.toBe(learned.value)
	})

	it("refuses an unknown profile rather than checking nothing", () => {
		expect(() => resolveProfile("v999")).toThrow(/Unknown baseline profile/)
	})

	it("passes v264's registered readings", () => {
		const verdict = assertProfile("v264", {
			"street.token_at_1": 0.573,
			"street.seg_at_1": 0.453,
			"street.oracle_at_5": 0.663,
			"street.oracle_at_10": 0.749,
		})

		expect(verdict.ok).toBe(true)
		expect(verdict.checked).toBe(4)
	})

	it("REFUSES the Phase 1 reading through the profile", () => {
		const verdict = assertProfile("v264", { "street.token_at_1": 0.348 })

		expect(verdict.ok).toBe(false)
	})

	it("ignores metrics the profile doesn't vouch for", () => {
		// A profile declares what it can vouch for, not everything a harness computes.
		const verdict = assertProfile("v264", { "street.token_at_1": 0.573, "postcode.something_else": 0.1 })

		expect(verdict.ok).toBe(true)
		expect(verdict.checked).toBe(1)
	})

	it("checks nothing when a run measured nothing", () => {
		expect(assertProfile("v264", {}).checked).toBe(0)
	})
})

describe("guardReport", () => {
	it("is silent when the instruments read true", () => {
		expect(() => guardReport([{ id: "parity.street.token_at_1@v264", observed: 0.573 }])).not.toThrow()
	})

	it("throws rather than letting a broken harness print", () => {
		expect(() => guardReport([{ id: "parity.street.token_at_1@v264", observed: 0.348 }])).toThrow(/REFUSING TO REPORT/)
	})
})

describe("formatVerdict", () => {
	it("names the deviation, the provenance, and the reproduce command", () => {
		const message = formatVerdict(assertBaselines([{ id: "parity.street.token_at_1@v264", observed: 0.348 }]))

		expect(message).toContain("REFUSING TO REPORT")
		expect(message).toContain("reads LOW")
		expect(message).toContain("-39.7%")
		expect(message).toContain("mailwoman eval oracle-k")
	})

	it("tells an unregistered reading how to register itself", () => {
		const message = formatVerdict(assertBaselines([{ id: "nope@v999", observed: 0.5 }]))

		expect(message).toContain("NO REGISTERED BASELINE")
		expect(message).toContain("baselines.json")
	})

	it("warns against widening tolerance instead of re-registering", () => {
		const message = formatVerdict(assertBaselines([{ id: "parity.street.token_at_1@v264", observed: 0.348 }]))

		expect(message).toContain("silent gate drift")
	})
})
