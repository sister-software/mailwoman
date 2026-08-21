/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Smoke tests for the invariance mini-suite RUNNER — weightless. `runInvarianceSuite` takes an
 *   injectable `ParseFn`, so these tests exercise the fixture-loading + comparison + summary + exit-code
 *   machinery with a FAKE parser instead of a real model (weight-dependent tests don't run in CI, #582).
 */

import {
	type InvarianceRow,
	type ParseFn,
	loadSuite,
	localeForCountry,
	runInvarianceSuite,
} from "mailwoman/eval-harness/invariance/runner"
import { describe, expect, it } from "vitest"

describe("loadSuite", () => {
	it("loads the shipped suite.jsonl, skipping the // header comment and blank lines", () => {
		const rows = loadSuite()

		// 19 base rows + 4 paired-punctuation rows = 23.
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
		const noop: ParseFn = async (): Promise<Record<string, string>> => ({})

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
		const parse: ParseFn = async (): Promise<Record<string, string>> => ({
			house_number: "1",
			street: "Fake St",
			locality: "Faketown",
		})

		const result = await runInvarianceSuite({ rows: [row], parse })

		expect(result.pass).toBe(true)
		expect(result.exitCode).toBe(0)
		expect(result.counts.lost).toBe(0)
		expect(result.counts.degraded).toBe(0)
		expect(result.outcomes).toHaveLength(3) // one per declared transform
	})

	it("fails (nonzero exit) on any LOST pair", async () => {
		const parse: ParseFn = async (raw): Promise<Record<string, string>> => {
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

		const parse: ParseFn = async (raw): Promise<Record<string, string>> => {
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

		const parse: ParseFn = async (): Promise<Record<string, string>> => {
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
		const parse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",") ? { house_number: "1", street: "Fake St" } : { street: "Fake St" }

		const result = await runInvarianceSuite({ rows: [brokenRow], parse, baselineParse: parse })

		expect(result.counts.lost).toBe(1) // still recorded
		expect(result.newCounts.lost).toBe(0) // but not NEW — baseline has it too
		expect(result.pass).toBe(true) // so the gate passes
		expect(result.outcomes[0]?.preExisting).toBe(true)
	})

	it("--baseline regression mode: a NEW violation the baseline does NOT have fails the gate", async () => {
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		const candidateParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",") ? { house_number: "1", street: "Fake St" } : { street: "Fake St" }

		const baselineParse: ParseFn = async (): Promise<Record<string, string>> => ({
			house_number: "1",
			street: "Fake St",
		})

		// baseline holds

		const result = await runInvarianceSuite({ rows: [brokenRow], parse: candidateParse, baselineParse })

		expect(result.newCounts.lost).toBe(1)
		expect(result.pass).toBe(false)
		expect(result.outcomes[0]?.preExisting).toBe(false)
	})

	it("--baseline severity gate: candidate LOST where baseline only DEGRADED is a NEW (gating) violation, not pre-existing", async () => {
		// The case the severity gate exists for: baseline drops `unit` on comma-drop (DEGRADED — non-critical),
		// candidate drops `house_number` on the SAME pair (LOST — critical). Severity-blind matching (both
		// sides merely "non-INVARIANT") would wrongly call this pre-existing and let it through. A candidate
		// verdict that is WORSE than the baseline's on the same (row, transform) must always be NEW.
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		const candidateParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { street: "Fake St", locality: "Faketown", unit: "Apt 1" } // house_number dropped — LOST
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const baselineParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { house_number: "1", street: "Fake St", locality: "Faketown" } // unit dropped — DEGRADED
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const result = await runInvarianceSuite({ rows: [brokenRow], parse: candidateParse, baselineParse })

		expect(result.outcomes[0]?.verdict).toBe("LOST")
		expect(result.outcomes[0]?.baselineVerdict).toBe("DEGRADED")
		expect(result.outcomes[0]?.preExisting).toBe(false) // NOT pre-existing — the candidate is WORSE
		expect(result.outcomes[0]?.gainedCapability).toBe(false) // baseline's original HAS criticals — not a gained row
		expect(result.newCounts.lost).toBe(1)
		expect(result.pass).toBe(false) // gates
	})

	it("the violation report line prints the baseline's ACTUAL verdict, not a hardcoded 'held INVARIANT' claim", async () => {
		// Same case as the severity-gate test above (baseline DEGRADED, candidate LOST — a NEW,
		// gating violation) — but this time asserting on the printed report LINE itself, not just the
		// structured outcome. A violation line that hardcodes "baseline held INVARIANT" is false on its
		// face here: the baseline was DEGRADED, so the line has to read the baseline's actual verdict.
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		const candidateParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { street: "Fake St", locality: "Faketown", unit: "Apt 1" } // house_number dropped — LOST
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const baselineParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { house_number: "1", street: "Fake St", locality: "Faketown" } // unit dropped — DEGRADED
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const lines: string[] = []

		await runInvarianceSuite({
			rows: [brokenRow],
			parse: candidateParse,
			baselineParse,
			report: (line) => lines.push(line),
		})

		const violationLine = lines.find((l) => l.includes("[NEW"))
		expect(violationLine).toContain("[NEW — baseline verdict was DEGRADED]")
		expect(violationLine).not.toContain("held INVARIANT")
	})

	it("--baseline severity gate: same verdict both sides (e.g. both DEGRADED) is still pre-existing", async () => {
		const degradedRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		const candidateParse: ParseFn = async (raw): Promise<Record<string, string>> =>
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
		// transform id (not a fake one) so a typo'd id string in that dispatch fails this test with a
		// spurious LOST instead of staying silently dead.
		const abbrevRow: InvarianceRow = {
			id: "abbrev-wiring-row",
			raw: "350 Fifth Avenue, New York, NY",
			country: "US",
			transforms: ["abbreviation-swap"],
		}

		const parse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes("Avenue")
				? { house_number: "350", street: "Fifth Avenue", locality: "New York", region: "NY" }
				: { house_number: "350", street: "Fifth Ave", locality: "New York", region: "NY" }

		// echoes the swap

		const result = await runInvarianceSuite({ rows: [abbrevRow], parse })

		expect(result.outcomes[0]?.verdict).toBe("INVARIANT")
		expect(result.pass).toBe(true)
	})

	it("throws when a fixture row declares a transform id that doesn't exist", async () => {
		const badRow: InvarianceRow = { ...row, transforms: ["not-a-real-transform"] }
		const parse: ParseFn = async (): Promise<Record<string, string>> => ({})

		await expect(runInvarianceSuite({ rows: [badRow], parse })).rejects.toThrow(/unknown invariance transform id/)
	})
})

describe("per-row locale + gained-capability class (#1516)", () => {
	it("localeForCountry maps the suite's four countries and falls back to en-US", () => {
		expect(localeForCountry("US")).toBe("en-US")
		expect(localeForCountry("GB")).toBe("en-GB")
		expect(localeForCountry("FR")).toBe("fr-FR")
		expect(localeForCountry("DE")).toBe("de-DE")
		expect(localeForCountry("XX")).toBe("en-US")
	})

	it("threads the row's country-derived locale into EVERY parse call (candidate and baseline, original and perturbed and idempotence)", async () => {
		const calls: Array<{ raw: string; locale?: string }> = []

		const parse: ParseFn = async (raw, opts) => {
			calls.push({ raw, locale: opts?.locale })

			return { house_number: "1", street: "Fake St", locality: "Faketown" }
		}

		const rows: InvarianceRow[] = [
			{ id: "fr-row", raw: "123 Rue Montmartre, Paris", country: "FR", transforms: ["lowercase", "comma-drop"] },
			{ id: "gb-row", raw: "The Grange, Fishburn, Stockton-on-Tees", country: "GB", transforms: ["lowercase"] },
			{
				id: "us-row",
				raw: "1600 Pennsylvania Ave NW, Washington, DC 20500",
				country: "US",
				transforms: ["lowercase", "idempotence"],
			},
		]

		// Transformed raws (lowercased, comma-dropped) won't equal any original raw, so key on a token
		// each row's raw keeps under every transform (matched case-insensitively).
		const localeByToken = new Map([
			["montmartre", "fr-FR"],
			["the grange", "en-GB"],
			["pennsylvania", "en-US"],
		] as const)

		// Same fake parser on both sides — this is a locale-THREADING test, not a regression test.
		await runInvarianceSuite({ rows, parse, baselineParse: parse })

		expect(calls.length).toBeGreaterThan(0)

		for (const call of calls) {
			const lower = call.raw.toLowerCase()
			const expected = localeByToken.get(localeByToken.keys().find((token) => lower.includes(token))!)

			expect(call.locale).toBe(expected)
		}
	})

	it("--baseline: a pair the candidate holds but the baseline violated is GAINED — reported, non-blocking", async () => {
		// The measured #1516 shape: the baseline's original parse never emits the row's critical
		// components (the quoted venue's street), so the whole row is a gained capability; on top of
		// that, this pair specifically flips — candidate INVARIANT where baseline DEGRADED.
		const row: InvarianceRow = {
			id: "gb-quoted-gain",
			raw: "The Grange, Fishburn, Stockton-on-Tees",
			country: "GB",
			transforms: ["case-fold"],
		}

		// Baseline: never parses the venue (no criticals anywhere); case-fold flips its region tag.
		const baselineParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw === raw.toUpperCase()
				? { region: "Stockton-on-Tees", locality: "The Grange Fishburn" }
				: { locality: "The Grange Fishburn" }

		// Candidate: holds the full address, INVARIANT under case-fold.
		const parse: ParseFn = async (): Promise<Record<string, string>> => ({
			street: "The Grange",
			dependent_locality: "Fishburn",
			region: "Stockton-on-Tees",
		})

		const lines: string[] = []

		const result = await runInvarianceSuite({
			rows: [row],
			parse,
			baselineParse,
			report: (line) => lines.push(line),
		})

		const outcome = result.outcomes[0]!
		expect(outcome.verdict).toBe("GAINED")
		expect(outcome.baselineVerdict).toBe("DEGRADED")
		expect(outcome.gainedCapability).toBe(true)
		expect(result.counts.gained).toBe(1)
		expect(result.newCounts.gained).toBe(1)
		expect(result.counts.lost).toBe(0)
		expect(result.newCounts.lost).toBe(0)
		expect(result.pass).toBe(true) // a gain is never a gate failure
		expect(lines.some((l) => l.startsWith("  + GAINED") && l.includes("[baseline verdict was DEGRADED]"))).toBe(true)
	})

	it("--baseline: violations on a row the baseline never parsed are gained-capability residuals — reported, non-blocking", async () => {
		// The measured #1516 shape for gb-quoted-venue: the baseline (v4.0.1) never emits the venue's
		// street in ANY register, so the row's baseline ORIGINAL has no critical components; the
		// candidate (v4.2.0) gained the street in 7/8 registers and loses it only on the register-flat
		// tail (quoted + comma-dropped). Those residual LOST/DEGRADED pairs are gains, not regressions.
		const row: InvarianceRow = {
			id: "gb-quoted-residual",
			raw: "The Grange, Fishburn, Stockton-on-Tees",
			country: "GB",
			transforms: ["comma-drop", "case-fold"],
		}

		// Baseline: parses the row WITHOUT any critical component, in every register.
		const baselineParse: ParseFn = async (): Promise<Record<string, string>> => ({
			region: "Stockton-on-Tees",
			locality: "The Grange",
		})

		// Candidate: holds the street on the original, loses it on comma-drop (LOST), flips the city
		// tag on case-fold (DEGRADED).
		const parse: ParseFn = async (raw): Promise<Record<string, string>> => {
			if (!raw.includes(",")) return { region: "Stockton-on-Tees", street: "The" }

			if (raw === raw.toUpperCase()) {
				return { region: "Stockton-on-Tees", dependent_locality: "Fishburn", street: "The Grange" }
			}

			return { locality: "Stockton-on-Tees", dependent_locality: "Fishburn", street: "The Grange" }
		}

		const result = await runInvarianceSuite({ rows: [row], parse, baselineParse })

		const commaDrop = result.outcomes.find((o) => o.transformID === "comma-drop")!
		expect(commaDrop.verdict).toBe("LOST")
		expect(commaDrop.gainedCapability).toBe(true)
		expect(commaDrop.preExisting).toBe(false) // not "the baseline also violates" — it could not

		const caseFold = result.outcomes.find((o) => o.transformID === "case-fold")!
		expect(caseFold.verdict).toBe("DEGRADED")
		expect(caseFold.gainedCapability).toBe(true)

		// The register-flat tail does not touch the gate: nothing is NEW.
		expect(result.newCounts.lost).toBe(0)
		expect(result.newCounts.degraded).toBe(0)
		expect(result.pass).toBe(true)
	})

	it("the violation report marks gained-capability residuals as non-blocking, not NEW", async () => {
		const row: InvarianceRow = {
			id: "gb-quoted-report",
			raw: "The Grange, Fishburn, Stockton-on-Tees",
			country: "GB",
			transforms: ["comma-drop"],
		}

		const baselineParse: ParseFn = async (): Promise<Record<string, string>> => ({
			region: "Stockton-on-Tees",
			locality: "The Grange",
		})

		const parse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { region: "Stockton-on-Tees", dependent_locality: "Fishburn", street: "The Grange" }
				: { region: "Stockton-on-Tees", street: "The" }

		const lines: string[] = []

		await runInvarianceSuite({
			rows: [row],
			parse,
			baselineParse,
			report: (line) => lines.push(line),
		})

		const violationLine = lines.find((l) => l.includes("✗ LOST"))

		expect(violationLine).toContain(
			"[gained-capability residual — the baseline never parsed this row's critical components — non-blocking]"
		)

		expect(violationLine).not.toContain("[NEW")
	})
})
