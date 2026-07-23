/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Smoke tests for the invariance mini-suite RUNNER — weightless. `runInvarianceSuite` takes an
 *   injectable `ParseFn`, so these tests exercise the fixture-loading + comparison + summary + exit-code
 *   machinery with a FAKE parser instead of a real model (weight-dependent tests don't run in CI, #582).
 */

import { describe, expect, it } from "vitest"

import { type InvarianceRow, type ParseFn, loadSuite, runInvarianceSuite } from "./runner.ts"

describe("loadSuite", () => {
	it("loads the shipped suite.jsonl, skipping the // header comment and blank lines", () => {
		const rows = loadSuite()

		// 19 base rows + 4 Task-9 paired-punctuation rows = 23.
		expect(rows.length).toBeGreaterThanOrEqual(16)
		expect(rows.length).toBeLessThanOrEqual(25)

		for (const row of rows) {
			expect(row.id).toBeTruthy()
			expect(row.raw).toBeTruthy()
			expect(row.country).toBeTruthy()
			expect(Array.isArray(row.transforms)).toBe(true)
			expect(row.transforms.length).toBeGreaterThan(0)
		}
	})

	it("carries the two gauntlet-famous landmark cases verbatim", () => {
		const rows = loadSuite()
		const raws = rows.map((r) => r.raw)

		expect(raws).toContain("1600 Pennsylvania Ave NW, Washington, DC 20500")
		expect(raws).toContain("350 Fifth Avenue, New York, NY 10118")
	})

	it("spans all four target countries", () => {
		const rows = loadSuite()
		const countries = new Set(rows.map((r) => r.country))

		expect(countries).toEqual(new Set(["US", "FR", "DE", "GB"]))
	})

	it("every declared transform id is a real transform (no fixture typos)", () => {
		// loadSuite itself doesn't validate ids — runInvarianceSuite does, via getTransform. Exercise it here
		// with a no-op parser so a fixture typo fails this test, not a real grading run.
		const rows = loadSuite()
		const noop: ParseFn = async () => ({})

		return expect(runInvarianceSuite({ rows, parse: noop })).resolves.toBeDefined()
	})
})

describe("runInvarianceSuite", () => {
	const row: InvarianceRow = {
		id: "fake-row",
		raw: "1 Fake St, Faketown",
		country: "US",
		transforms: ["comma-drop", "lowercase", "idempotence"],
	}

	it("is a clean PASS when every transformed parse matches the original exactly", async () => {
		const parse: ParseFn = async () => ({ house_number: "1", street: "Fake St", locality: "Faketown" })

		const result = await runInvarianceSuite({ rows: [row], parse })

		expect(result.pass).toBe(true)
		expect(result.exitCode).toBe(0)
		expect(result.counts.lost).toBe(0)
		expect(result.counts.degraded).toBe(0)
		expect(result.outcomes.length).toBe(3) // one per declared transform
	})

	it("fails (nonzero exit) on any LOST pair", async () => {
		const parse: ParseFn = async (raw) => {
			// The comma-drop variant loses the house number entirely — an injected LOST case.
			if (!raw.includes(",")) return { street: "Fake St", locality: "Faketown" }

			return { house_number: "1", street: "Fake St", locality: "Faketown" }
		}

		const result = await runInvarianceSuite({ rows: [row], parse })

		expect(result.pass).toBe(false)
		expect(result.exitCode).toBe(1)
		expect(result.counts.lost).toBeGreaterThan(0)
	})

	it("respects --max-degraded: a DEGRADED count under the cap still passes", async () => {
		const degradedRow: InvarianceRow = { ...row, transforms: ["lowercase"] }
		const parse: ParseFn = async (raw) => {
			const base = { house_number: "1", street: "Fake St", locality: "Faketown" }

			// The lowercased variant picks up a spurious unit tag — non-critical drift, DEGRADED not LOST.
			if (raw === raw.toLowerCase() && raw !== "1 fake st, faketown".toUpperCase()) {
				return { ...base, unit: "Apt 1" }
			}

			return base
		}

		const failed = await runInvarianceSuite({ rows: [degradedRow], parse, maxDegraded: 0 })
		expect(failed.pass).toBe(false)

		const passed = await runInvarianceSuite({ rows: [degradedRow], parse, maxDegraded: 1 })
		expect(passed.pass).toBe(true)
	})

	it("idempotence catches nondeterminism — two independent calls that disagree", async () => {
		let call = 0
		const idempoRow: InvarianceRow = { ...row, transforms: ["idempotence"] }
		const parse: ParseFn = async () => {
			call++

			// Flip a value on the second call — simulated nondeterminism.
			return call % 2 === 0 ? { house_number: "1", street: "Fake St" } : { house_number: "2", street: "Fake St" }
		}

		const result = await runInvarianceSuite({ rows: [idempoRow], parse })

		expect(result.counts.lost).toBe(1) // house_number is critical
		expect(result.pass).toBe(false)
	})

	it("--baseline regression mode: a violation the baseline ALSO has is reported but non-blocking", async () => {
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }
		// Both candidate and baseline lose the house number on comma-drop — a PRE-EXISTING gap.
		const parse: ParseFn = async (raw) =>
			raw.includes(",") ? { house_number: "1", street: "Fake St" } : { street: "Fake St" }

		const result = await runInvarianceSuite({ rows: [brokenRow], parse, baselineParse: parse })

		expect(result.counts.lost).toBe(1) // still recorded
		expect(result.newCounts.lost).toBe(0) // but not NEW — baseline has it too
		expect(result.pass).toBe(true) // so the gate passes
		expect(result.outcomes[0]?.preExisting).toBe(true)
	})

	it("--baseline regression mode: a NEW violation the baseline does NOT have fails the gate", async () => {
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }
		const candidateParse: ParseFn = async (raw) =>
			raw.includes(",") ? { house_number: "1", street: "Fake St" } : { street: "Fake St" }
		const baselineParse: ParseFn = async () => ({ house_number: "1", street: "Fake St" }) // baseline holds

		const result = await runInvarianceSuite({ rows: [brokenRow], parse: candidateParse, baselineParse })

		expect(result.newCounts.lost).toBe(1)
		expect(result.pass).toBe(false)
		expect(result.outcomes[0]?.preExisting).toBe(false)
	})

	it("--baseline severity gate: candidate LOST where baseline only DEGRADED is a NEW (gating) violation, not pre-existing", async () => {
		// The reviewer's exact reproduction: baseline drops `unit` on comma-drop (DEGRADED — non-critical),
		// candidate drops `house_number` on the SAME pair (LOST — critical). Severity-blind matching (both
		// sides merely "non-INVARIANT") would wrongly call this pre-existing and let it through. A candidate
		// verdict that is WORSE than the baseline's on the same (row, transform) must always be NEW.
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }
		const candidateParse: ParseFn = async (raw) =>
			raw.includes(",")
				? { street: "Fake St", locality: "Faketown", unit: "Apt 1" } // house_number dropped — LOST
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }
		const baselineParse: ParseFn = async (raw) =>
			raw.includes(",")
				? { house_number: "1", street: "Fake St", locality: "Faketown" } // unit dropped — DEGRADED
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const result = await runInvarianceSuite({ rows: [brokenRow], parse: candidateParse, baselineParse })

		expect(result.outcomes[0]?.verdict).toBe("LOST")
		expect(result.outcomes[0]?.baselineVerdict).toBe("DEGRADED")
		expect(result.outcomes[0]?.preExisting).toBe(false) // NOT pre-existing — the candidate is WORSE
		expect(result.newCounts.lost).toBe(1)
		expect(result.pass).toBe(false) // gates
	})

	it("--baseline severity gate: same verdict both sides (e.g. both DEGRADED) is still pre-existing", async () => {
		const degradedRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }
		const candidateParse: ParseFn = async (raw) =>
			raw.includes(",")
				? { house_number: "1", street: "Fake St", locality: "Faketown" } // unit dropped — DEGRADED
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }
		const baselineParse = candidateParse // identical shape — both DEGRADED on the same pair

		const result = await runInvarianceSuite({ rows: [degradedRow], parse: candidateParse, baselineParse })

		expect(result.outcomes[0]?.verdict).toBe("DEGRADED")
		expect(result.outcomes[0]?.baselineVerdict).toBe("DEGRADED")
		expect(result.outcomes[0]?.preExisting).toBe(true)
		expect(result.pass).toBe(true)
	})

	it("wires abbreviation-swap through the canonicalizing comparator (typo-in-id dispatch regression guard)", async () => {
		// Swapping "Avenue" -> "Ave" in the input makes a span-extraction model correctly echo "Ave" in its
		// `street` output — that's the transform doing its job, not a violation. Comparing RAW values would
		// flag it as a false LOST (street is critical); compareForTransform's abbreviation-swap branch
		// canonicalizes both sides to long-form first. This test goes through the REAL "abbreviation-swap"
		// transform id (not a fake one) so a typo'd id string in that dispatch (the false-positive class the
		// build report found) fails this test with a spurious LOST instead of staying silently dead.
		const abbrevRow: InvarianceRow = {
			id: "abbrev-wiring-row",
			raw: "350 Fifth Avenue, New York, NY",
			country: "US",
			transforms: ["abbreviation-swap"],
		}
		const parse: ParseFn = async (raw) =>
			raw.includes("Avenue")
				? { house_number: "350", street: "Fifth Avenue", locality: "New York", region: "NY" }
				: { house_number: "350", street: "Fifth Ave", locality: "New York", region: "NY" } // echoes the swap

		const result = await runInvarianceSuite({ rows: [abbrevRow], parse })

		expect(result.outcomes[0]?.verdict).toBe("INVARIANT")
		expect(result.pass).toBe(true)
	})

	it("throws when a fixture row declares a transform id that doesn't exist", async () => {
		const badRow: InvarianceRow = { ...row, transforms: ["not-a-real-transform"] }
		const parse: ParseFn = async () => ({})

		await expect(runInvarianceSuite({ rows: [badRow], parse })).rejects.toThrow(/unknown invariance transform id/)
	})
})
