/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `runInvarianceSuite` takes an injectable `ParseFn`, so these tests run weightless in CI with a fake
 *   parser instead of a real model.
 */

import { describe, expect, it } from "vitest"

import {
	type InvarianceRow,
	type ParseFn,
	loadSuite,
	localeForCountry,
	runInvarianceSuite,
} from "#eval-harness/invariance/runner"

describe("loadSuite", () => {
	it("loads the shipped suite.jsonl, skipping the // header comment and blank lines", async () => {
		const rows = await loadSuite()

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

	it("carries the two gauntlet-famous landmark cases verbatim", async () => {
		const rows = await loadSuite()
		const raws = rows.map((r) => r.raw)

		expect(raws).toContain("1600 Pennsylvania Ave NW, Washington, DC 20500")
		expect(raws).toContain("350 Fifth Avenue, New York, NY 10118")
	})

	it("spans all four target countries", async () => {
		const rows = await loadSuite()
		const countries = new Set(rows.map((r) => r.country))

		expect(countries).toEqual(new Set(["US", "FR", "DE", "GB"]))
	})

	it("every declared transform id is a real transform (no fixture typos)", async () => {
		// `loadSuite` does not validate transform ids — `runInvarianceSuite` does — so exercising
		// it with a no-op parser makes a fixture typo fail here rather than in a grading run.
		const rows = await loadSuite()
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
		expect(result.outcomes).toHaveLength(3)
	})

	it("fails (nonzero exit) on any LOST pair", async () => {
		const parse: ParseFn = async (raw): Promise<Record<string, string>> => {
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

			return call % 2 === 0 ? { house_number: "1", street: "Fake St" } : { house_number: "2", street: "Fake St" }
		}

		const result = await runInvarianceSuite({ rows: [idempoRow], parse })

		expect(result.counts.lost).toBe(1) // house_number is critical
		expect(result.pass).toBe(false)
	})

	it("--baseline regression mode: a violation the baseline ALSO has is reported but non-blocking", async () => {
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		// Both candidate and baseline lose the house number on comma-drop — a PRE-existing gap.
		const parse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",") ? { house_number: "1", street: "Fake St" } : { street: "Fake St" }

		const result = await runInvarianceSuite({ rows: [brokenRow], parse, baselineParse: parse })

		expect(result.counts.lost).toBe(1)
		expect(result.newCounts.lost).toBe(0)
		expect(result.pass).toBe(true)
		expect(result.outcomes[0]?.preExisting).toBe(true)
	})

	it("--baseline regression mode: a NEW violation the baseline does NOT have fails the check", async () => {
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		const candidateParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",") ? { house_number: "1", street: "Fake St" } : { street: "Fake St" }

		const baselineParse: ParseFn = async (): Promise<Record<string, string>> => ({
			house_number: "1",
			street: "Fake St",
		})

		const result = await runInvarianceSuite({ rows: [brokenRow], parse: candidateParse, baselineParse })

		expect(result.newCounts.lost).toBe(1)
		expect(result.pass).toBe(false)
		expect(result.outcomes[0]?.preExisting).toBe(false)
	})

	it("--baseline severity check: candidate LOST where baseline only DEGRADED is a NEW (enforcing) violation, not pre-existing", async () => {
		// A candidate verdict worse than the baseline's on the same (row, transform)
		// must count as a new violation.
		// Severity-blind matching would wrongly call it pre-existing.
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		const candidateParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { street: "Fake St", locality: "Faketown", unit: "Apt 1" }
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const baselineParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { house_number: "1", street: "Fake St", locality: "Faketown" }
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const result = await runInvarianceSuite({ rows: [brokenRow], parse: candidateParse, baselineParse })

		expect(result.outcomes[0]?.verdict).toBe("LOST")
		expect(result.outcomes[0]?.baselineVerdict).toBe("DEGRADED")
		expect(result.outcomes[0]?.preExisting).toBe(false)
		expect(result.outcomes[0]?.gainedCapability).toBe(false)
		expect(result.newCounts.lost).toBe(1)
		expect(result.pass).toBe(false)
	})

	it("the violation report line prints the baseline's ACTUAL verdict, not a hardcoded 'held INVARIANT' claim", async () => {
		// A violation line that hardcodes "baseline held invariant" is false when the baseline
		// was degraded, so the line must read the baseline's actual verdict.
		const brokenRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		const candidateParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { street: "Fake St", locality: "Faketown", unit: "Apt 1" }
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const baselineParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { house_number: "1", street: "Fake St", locality: "Faketown" }
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

	it("--baseline severity check: same verdict both sides (e.g. both DEGRADED) is still pre-existing", async () => {
		const degradedRow: InvarianceRow = { ...row, transforms: ["comma-drop"] }

		const candidateParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw.includes(",")
				? { house_number: "1", street: "Fake St", locality: "Faketown" }
				: { house_number: "1", street: "Fake St", locality: "Faketown", unit: "Apt 1" }

		const baselineParse = candidateParse

		const result = await runInvarianceSuite({ rows: [degradedRow], parse: candidateParse, baselineParse })

		expect(result.outcomes[0]?.verdict).toBe("DEGRADED")
		expect(result.outcomes[0]?.baselineVerdict).toBe("DEGRADED")
		expect(result.outcomes[0]?.preExisting).toBe(true)
		expect(result.pass).toBe(true)
	})

	it("wires abbreviation-swap through the canonicalizing comparator (typo-in-id dispatch regression guard)", async () => {
		// A raw-value comparison would flag a correctly echoed "Ave" as a false `lost`,
		// so `compareForTransform` canonicalizes both sides to long form.
		// This test exercises the real transform id so a typo in that dispatch fails here.
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

		// Transformed raws will not equal any original raw, so key on a token each row
		// keeps under every transform, matched case-insensitively.
		const localeByToken = new Map([
			["montmartre", "fr-FR"],
			["the grange", "en-GB"],
			["pennsylvania", "en-US"],
		] as const)

		// This is a locale-threading test rather than a regression test, so both sides use the same fake parser.
		await runInvarianceSuite({ rows, parse, baselineParse: parse })

		expect(calls.length).toBeGreaterThan(0)

		for (const call of calls) {
			const lower = call.raw.toLowerCase()
			const expected = localeByToken.get(localeByToken.keys().find((token) => lower.includes(token))!)

			expect(call.locale).toBe(expected)
		}
	})

	it("--baseline: a pair the candidate holds but the baseline violated is GAINED — reported, non-blocking", async () => {
		// The baseline's original parse never emits the row's critical components,
		// so the row is a gained capability.
		// This pair also flips candidate-invariant where baseline degraded.
		const row: InvarianceRow = {
			id: "gb-quoted-gain",
			raw: "The Grange, Fishburn, Stockton-on-Tees",
			country: "GB",
			transforms: ["case-fold"],
		}

		const baselineParse: ParseFn = async (raw): Promise<Record<string, string>> =>
			raw === raw.toUpperCase()
				? { region: "Stockton-on-Tees", locality: "The Grange Fishburn" }
				: { locality: "The Grange Fishburn" }

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
		expect(result.pass).toBe(true) // a gain is never a check failure
		expect(lines.some((l) => l.startsWith("  + GAINED") && l.includes("[baseline verdict was DEGRADED]"))).toBe(true)
	})

	it("--baseline: violations on a row the baseline never parsed are gained-capability residuals — reported, non-blocking", async () => {
		// The baseline never emits the venue's street in any register, so residual lost/degraded
		// pairs on the register-flat tail are gains rather than regressions.
		const row: InvarianceRow = {
			id: "gb-quoted-residual",
			raw: "The Grange, Fishburn, Stockton-on-Tees",
			country: "GB",
			transforms: ["comma-drop", "case-fold"],
		}

		const baselineParse: ParseFn = async (): Promise<Record<string, string>> => ({
			region: "Stockton-on-Tees",
			locality: "The Grange",
		})

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

		// The register-flat tail does not touch the check: no row is new.
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
