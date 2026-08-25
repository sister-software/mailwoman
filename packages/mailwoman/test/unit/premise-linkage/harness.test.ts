/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1902's acceptance criteria, one named test each. Every case runs on the shipped SYNTHETIC fixture
 *   — invented addresses, invented identifiers in the reserved 0-prefixed range, no model, no
 *   gazetteer, no network — so the suite runs anywhere and no licensed row can reach it.
 *
 *   What the suite pins is the SHAPE of the report rather than any prose about it: a numerator and its
 *   denominator for every rate, an outcome vocabulary neither arm can privately redefine, and a writer
 *   that refuses before it opens a file.
 */

import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { AuthoritativeResponseStatus, type AuthoritativeQuery } from "@mailwoman/core/resolver"
import {
	syntheticFixtureAdapter,
	syntheticFixtureDeps,
	syntheticFixtureProvider,
	type PremiseLinkageAdapter,
} from "mailwoman/eval-harness/premise-linkage/adapter"
import { assertUsableSalt, caseIDFor } from "mailwoman/eval-harness/premise-linkage/case-id"
import {
	PremiseLinkageRedactionError,
	PremiseLinkageRedactionReason,
	publishableReport,
	writePremiseLinkageReport,
} from "mailwoman/eval-harness/premise-linkage/report-writer"
import {
	AUTHORITATIVE_ARM_NAME,
	OPEN_ARM_NAME,
	outcomeFor,
	resolvePremiseLinkageConfig,
	runPremiseLinkage,
	type PremiseLinkageRunOptions,
	type PremiseLinkageRunResult,
} from "mailwoman/eval-harness/premise-linkage/run"
import {
	PremiseLinkageFailureCategory,
	PremiseLinkageMode,
	PremiseLinkageOutcome,
	PremiseLinkagePolicy,
	type PremiseLinkageArmReport,
	type PremiseLinkageCount,
	type PremiseLinkageInputRow,
	type PremiseLinkageRates,
	type PremiseLinkageReport,
} from "mailwoman/eval-harness/premise-linkage/schema"
import { describe, expect, it } from "vitest"

const SALT = "0123456789abcdef0123456789abcdef"
const SECOND_SALT = "fedcba9876543210fedcba9876543210"
const MAILWOMAN_VERSION = "0.0.0-test"

async function collectRows(adapter: PremiseLinkageAdapter): Promise<PremiseLinkageInputRow[]> {
	const rows: PremiseLinkageInputRow[] = []

	for await (const row of adapter.rows()) {
		rows.push(row)
	}

	return rows
}

/**
 * An adapter over an explicit row list — used to feed the same fixture rows back in a different order.
 */
function listAdapter(name: string, rows: readonly PremiseLinkageInputRow[]): PremiseLinkageAdapter {
	return {
		name,
		async *rows(): AsyncIterable<PremiseLinkageInputRow> {
			for (const row of rows) {
				yield row
			}
		},
	}
}

function baseOptions(overrides: Partial<PremiseLinkageRunOptions> = {}): PremiseLinkageRunOptions {
	return {
		adapter: syntheticFixtureAdapter(),
		deps: syntheticFixtureDeps(),
		authoritativeProvider: syntheticFixtureProvider(),
		salt: SALT,
		policy: PremiseLinkagePolicy.AbstainPermitted,
		minCellSize: 1,
		mailwomanVersion: MAILWOMAN_VERSION,
		mode: PremiseLinkageMode.Synthetic,
		...overrides,
	}
}

async function syntheticRun(overrides: Partial<PremiseLinkageRunOptions> = {}): Promise<PremiseLinkageRunResult> {
	return runPremiseLinkage(baseOptions(overrides))
}

function armNamed(report: PremiseLinkageReport, arm: string): PremiseLinkageArmReport {
	const found = report.arms.find((entry) => entry.arm === arm)

	if (!found) throw new Error(`the report carries no arm named ${arm}`)

	return found
}

/**
 * Run something that must refuse, and hand back the refusal itself — a reason and a path are what the writer promises,
 * and a message match would pass on a refusal for the wrong reason.
 */
function refusalFrom(run: () => unknown): PremiseLinkageRedactionError {
	try {
		run()
	} catch (error) {
		if (error instanceof PremiseLinkageRedactionError) return error

		throw error
	}

	throw new Error("expected the report writer to refuse, and it did not")
}

function isCount(value: unknown): value is PremiseLinkageCount {
	if (typeof value !== "object" || value === null) return false

	return typeof (value as PremiseLinkageCount).n === "number" && typeof (value as PremiseLinkageCount).of === "number"
}

describe("#1902: synthetic fixtures exercise exact, wrong, refused and ambiguous in both required arms", () => {
	it("grades every fixture row through both arms, and the authoritative arm produces all four outcomes", async () => {
		const run = await syntheticRun()
		const fixtureRows = await collectRows(syntheticFixtureAdapter())

		// Both arms graded every row: two arms' worth of result rows, and no row silently dropped.
		expect(run.rows).toHaveLength(fixtureRows.length * 2)
		expect(armNamed(run.report, OPEN_ARM_NAME).rowsRead).toBe(fixtureRows.length)
		expect(armNamed(run.report, AUTHORITATIVE_ARM_NAME).rowsRead).toBe(fixtureRows.length)

		const authoritativeOutcomes = new Set(
			run.rows.filter((row) => row.providerName !== "none").map((row) => row.outcome)
		)

		expect(authoritativeOutcomes).toContain(PremiseLinkageOutcome.Exact)
		expect(authoritativeOutcomes).toContain(PremiseLinkageOutcome.Wrong)
		expect(authoritativeOutcomes).toContain(PremiseLinkageOutcome.Refused)
		expect(authoritativeOutcomes).toContain(PremiseLinkageOutcome.Ambiguous)
	})

	it("grades both arms through ONE mapper, so neither arm can hold a private definition of `exact`", () => {
		const expected = { scheme: "uprn", id: "000000000001" }

		// The open arm's state: no authoritative block at all. A refusal, never a wrong answer.
		expect(outcomeFor(undefined, expected)).toEqual({
			outcome: PremiseLinkageOutcome.Refused,
			failureCategory: PremiseLinkageFailureCategory.ArmAssertsNoIdentifier,
		})

		expect(
			outcomeFor(
				{
					provider: "p",
					status: "matched",
					matches: [{ provider_place_id: "a", object_ids: { uprn: "000000000001" }, match_status: "exact" }],
				},
				expected
			)
		).toEqual({ outcome: PremiseLinkageOutcome.Exact })

		expect(
			outcomeFor(
				{
					provider: "p",
					status: "matched",
					matches: [{ provider_place_id: "a", object_ids: { uprn: "000000000009" }, match_status: "exact" }],
				},
				expected
			).outcome
		).toBe(PremiseLinkageOutcome.Wrong)

		expect(outcomeFor({ provider: "p", status: "refused" }, expected).outcome).toBe(PremiseLinkageOutcome.Refused)

		// Ambiguity keeps its candidates and is never collapsed into the first one.
		expect(
			outcomeFor(
				{
					provider: "p",
					status: "ambiguous",
					matches: [{ provider_place_id: "a", object_ids: { uprn: "000000000001" }, match_status: "exact" }],
				},
				expected
			).outcome
		).toBe(PremiseLinkageOutcome.Ambiguous)
	})

	it("keeps a transport failure and a scheme-less match OUT of every rate, each with its own count", async () => {
		const run = await syntheticRun()
		const authoritative = armNamed(run.report, AUTHORITATIVE_ARM_NAME)

		const categories = run.rows
			.filter((row) => row.outcome === PremiseLinkageOutcome.Errored)
			.map((row) => row.failureCategory)

		expect(categories).toContain(PremiseLinkageFailureCategory.TransportError)
		expect(categories).toContain(PremiseLinkageFailureCategory.SchemeAbsent)

		expect(authoritative.erroredOverAll).toEqual({ n: 2, of: authoritative.rowsRead })

		// Ungradable rows are outside the eligible denominator, in both directions: it is smaller than the run.
		expect(authoritative.overall.exactOverEligible.of).toBeLessThan(authoritative.rowsRead)
	})
})

describe("#1902: the report prints every numerator and denominator", () => {
	it("states an `n` and an `of` for every rate, at the run level and per class", async () => {
		const { report } = await syntheticRun()

		for (const arm of report.arms) {
			const rateGroups: PremiseLinkageRates[] = [arm.overall, ...Object.values(arm.perClass)]

			for (const rates of rateGroups) {
				expect(isCount(rates.exactOverEligible)).toBe(true)
				expect(isCount(rates.wrongOverEligible)).toBe(true)
				expect(isCount(rates.refusedOverAll)).toBe(true)
				expect(isCount(rates.ambiguousOverAll)).toBe(true)
			}

			expect(isCount(arm.erroredOverAll)).toBe(true)

			for (const threshold of arm.coordinateThresholds) {
				expect(typeof threshold.thresholdM).toBe("number")
				expect(isCount(threshold.withinThreshold)).toBe(true)
			}
		}

		expect(isCount(report.comparison.changed)).toBe(true)
		expect(isCount(report.comparison.improved)).toBe(true)
		expect(isCount(report.comparison.regressed)).toBe(true)
	})

	it("counts arm-to-arm movement over ALL rows, with improved and regressed inside changed", async () => {
		const { report } = await syntheticRun()
		const { comparison } = report

		expect(comparison.baselineArm).toBe(OPEN_ARM_NAME)
		expect(comparison.candidateArm).toBe(AUTHORITATIVE_ARM_NAME)
		expect(comparison.changed.of).toBe(armNamed(report, OPEN_ARM_NAME).rowsRead)
		expect(comparison.improved.of).toBe(comparison.changed.of)
		expect(comparison.improved.n + comparison.regressed.n).toBeLessThanOrEqual(comparison.changed.n)

		// The open arm refuses on identity everywhere, so a provider match is a strict improvement and a
		// provider that names the wrong premise is a strict regression.
		expect(comparison.improved.n).toBeGreaterThan(0)
		expect(comparison.regressed.n).toBeGreaterThan(0)
	})

	it("moves refusals into the eligible denominator only when the policy required a unique answer", async () => {
		const permitted = await syntheticRun({ policy: PremiseLinkagePolicy.AbstainPermitted })
		const required = await syntheticRun({ policy: PremiseLinkagePolicy.UniqueRequired })

		const permittedOpen = armNamed(permitted.report, OPEN_ARM_NAME)
		const requiredOpen = armNamed(required.report, OPEN_ARM_NAME)

		// Abstention permitted: the open arm's refusals leave the denominator entirely.
		expect(permittedOpen.overall.exactOverEligible).toEqual({ n: 0, of: 0 })

		// A unique answer required: the same refusals count against it — and are STILL recorded as refusals.
		expect(requiredOpen.overall.exactOverEligible.of).toBeGreaterThan(0)
		expect(requiredOpen.overall.refusedOverAll).toEqual(permittedOpen.overall.refusedOverAll)

		const openRows = required.rows.filter((row) => row.providerName === "none")

		expect(openRows.every((row) => row.outcome !== PremiseLinkageOutcome.Wrong)).toBe(true)
	})
})

describe("#1902: reordering the private input does not change aggregate results", () => {
	it("produces deep-equal aggregates from the same rows fed in reverse", async () => {
		const rows = await collectRows(syntheticFixtureAdapter())
		const forward = await syntheticRun({ adapter: listAdapter("forward", rows) })
		const reversed = await syntheticRun({ adapter: listAdapter("reversed", rows.toReversed()) })

		expect(reversed.report).toEqual(forward.report)
	})
})

describe("#1902: two runs with different salts cannot be joined by their case identifiers", () => {
	it("shares no case identifier between two salts over the same inputs", async () => {
		const rows = await collectRows(syntheticFixtureAdapter())
		const first = new Set(rows.map((row) => caseIDFor(row.input, SALT)))
		const second = new Set(rows.map((row) => caseIDFor(row.input, SECOND_SALT)))
		const shared = [...first].filter((id) => second.has(id))

		expect(rows.length).toBeGreaterThan(0)
		expect(first.size).toBe(rows.length)
		expect(shared).toHaveLength(0)
	})

	it("is stable within one salt, so the two arms of one run pair row for row", async () => {
		const run = await syntheticRun()
		const open = run.rows.filter((row) => row.providerName === "none").map((row) => row.caseID)
		const authoritative = run.rows.filter((row) => row.providerName !== "none").map((row) => row.caseID)

		expect(authoritative).toEqual(open)
	})

	it("refuses a salt short enough to enumerate, before any row is read", () => {
		expect(() => assertUsableSalt("short")).toThrow(/at least 16/u)
		expect(() => assertUsableSalt(SALT)).not.toThrow()
	})
})

describe("#1902: the public-report writer refuses an injected disclosure", () => {
	it("refuses a raw address in a report field, naming the path", async () => {
		const run = await syntheticRun()
		const injected = structuredClone(run.report)

		injected.arms[0]!.providerName = "12 Downing Terrace"

		const refusal = refusalFrom(() => publishableReport({ ...run, report: injected }))

		expect(refusal.path).toBe("report.arms[0].providerName")
		expect(refusal.reason).toBe(PremiseLinkageRedactionReason.AddressShape)
	})

	it("refuses an authoritative identifier in a report field", async () => {
		const run = await syntheticRun()
		const injected = structuredClone(run.report)

		injected.arms[0]!.providerDatasetVersion = "100023336956"

		const refusal = refusalFrom(() => publishableReport({ ...run, report: injected }))

		expect(refusal.reason).toBe(PremiseLinkageRedactionReason.IdentifierShape)
		expect(refusal.path).toBe("report.arms[0].providerDatasetVersion")
	})

	it("refuses a field holding an input this run read, and says so rather than guessing", async () => {
		const run = await syntheticRun()
		const injected = structuredClone(run.report)

		injected.arms[0]!.providerName = `graded ${run.inputs[0]!} in 4 ms`

		// The one check that PROVES a disclosure — this string was read from the run's own input — is the
		// one reported, ahead of the two heuristics the same value also trips.
		expect(refusalFrom(() => publishableReport({ ...run, report: injected })).reason).toBe(
			PremiseLinkageRedactionReason.InputSubstring
		)
	})

	it("refuses a provider payload smuggled in under a key the schema does not declare", async () => {
		const run = await syntheticRun()
		const injected = structuredClone(run.report) as PremiseLinkageReport & { providerPayload?: unknown }

		injected.providerPayload = { uprn: "100023336956", lat: 51.5 }

		const refusal = refusalFrom(() => publishableReport({ ...run, report: injected }))

		expect(refusal.path).toBe("report.providerPayload")
		expect(refusal.reason).toBe(PremiseLinkageRedactionReason.UnknownKey)
	})

	it("refuses a coordinate error on a row whose terms forbid publishing one", async () => {
		const run = await syntheticRun()
		const rows = run.rows.map((row) => (row.coordinatePublishable ? row : { ...row, coordinateErrorM: 4 }))

		expect(refusalFrom(() => publishableReport({ ...run, rows })).reason).toBe(
			PremiseLinkageRedactionReason.UnpublishableCoordinate
		)
	})

	it("computes no coordinate error for an unpublishable row in the first place", async () => {
		const run = await syntheticRun()
		const unpublishable = run.rows.filter((row) => !row.coordinatePublishable)

		expect(unpublishable.length).toBeGreaterThan(0)
		expect(unpublishable.every((row) => row.coordinateErrorM === undefined)).toBe(true)
	})

	it("refuses a whole run smaller than the agreed minimum cell size", async () => {
		const rows = await collectRows(syntheticFixtureAdapter())
		const run = await syntheticRun({ adapter: listAdapter("one-row", rows.slice(0, 1)), minCellSize: 5 })

		expect(refusalFrom(() => publishableReport(run)).reason).toBe(PremiseLinkageRedactionReason.RunBelowMinimum)
	})

	it("writes no file when it refuses", async () => {
		const run = await syntheticRun()
		const directory = await mkdtemp(join(tmpdir(), "premise-linkage-"))
		const target = join(directory, "report.json")
		const injected = structuredClone(run.report)

		injected.arms[0]!.providerName = "12 Downing Terrace"

		await expect(writePremiseLinkageReport(target, { ...run, report: injected })).rejects.toThrow(/refusing to write/u)
		await expect(readFile(target, "utf8")).rejects.toThrow(/ENOENT/u)
	})

	it("writes the suppressed report when every check passes", async () => {
		const run = await syntheticRun()
		const directory = await mkdtemp(join(tmpdir(), "premise-linkage-"))
		const target = join(directory, "report.json")
		const written = await writePremiseLinkageReport(target, run)
		const roundTripped = parseJSONStrict<PremiseLinkageReport>(await readFile(target, "utf8"))

		expect(roundTripped).toEqual(written)
	})
})

describe("#1902: small result cells are suppressed according to the configured minimum", () => {
	it("removes every per-class cell below the minimum and counts the removals", async () => {
		const permissive = await syntheticRun({ minCellSize: 1 })
		const strict = await syntheticRun({ minCellSize: 3 })

		const permissiveReport = publishableReport(permissive)
		const strictReport = publishableReport(strict)

		const permissiveClasses = Object.keys(armNamed(permissiveReport, AUTHORITATIVE_ARM_NAME).perClass)
		const strictClasses = Object.keys(armNamed(strictReport, AUTHORITATIVE_ARM_NAME).perClass)

		expect(permissiveReport.suppressedCells).toBe(0)
		expect(strictClasses.length).toBeLessThan(permissiveClasses.length)
		expect(strictReport.suppressedCells).toBeGreaterThan(0)

		for (const arm of strictReport.arms) {
			for (const rates of Object.values(arm.perClass)) {
				expect(rates.refusedOverAll.of).toBeGreaterThanOrEqual(strictReport.minCellSize)
			}

			for (const threshold of arm.coordinateThresholds) {
				expect(threshold.withinThreshold.of).toBeGreaterThanOrEqual(strictReport.minCellSize)
			}
		}
	})
})

describe("#1902: the Mailwoman-only arm uses the production pipeline, unchanged", () => {
	it("consults the provider once per row, not twice — the open arm is handed none", async () => {
		const log: AuthoritativeQuery[] = []
		const rows = await collectRows(syntheticFixtureAdapter())

		await syntheticRun({
			adapter: listAdapter("logged", rows),
			authoritativeProvider: syntheticFixtureProvider({ log }),
		})

		// Two arms, one provider consult per row: the open arm ran the same rows through the same
		// `geocodeAddress` with nothing in the provider slot.
		expect(log).toHaveLength(rows.length)
	})

	it("runs both arms through the same resolver, twice per row", async () => {
		const deps = syntheticFixtureDeps()
		const rows = await collectRows(syntheticFixtureAdapter())
		let resolveCalls = 0

		await runPremiseLinkage(
			baseOptions({
				adapter: listAdapter("one", rows.slice(0, 1)),
				deps: {
					...deps,
					resolver: {
						resolveTree: async (tree) => {
							resolveCalls++

							return deps.resolver.resolveTree(tree)
						},
					},
				},
			})
		)

		expect(resolveCalls).toBe(2)
	})

	it("produces an open-arm result carrying no authoritative block at all", async () => {
		const run = await syntheticRun()
		const openRows = run.rows.filter((row) => row.providerName === "none")

		expect(openRows.length).toBeGreaterThan(0)

		// `none` is the recorded provider precisely because the arm consulted one and got nothing back —
		// the block is absent, so every open row reports the structural refusal.
		expect(openRows.every((row) => row.failureCategory === PremiseLinkageFailureCategory.ArmAssertsNoIdentifier)).toBe(
			true
		)
	})
})

describe("#1902: the authoritative arm consumes the #1901 provider contract", () => {
	it("hands the fixture provider the assembled #1901 query, once per row", async () => {
		const log: AuthoritativeQuery[] = []
		const rows = await collectRows(syntheticFixtureAdapter())

		await syntheticRun({
			adapter: listAdapter("logged", rows),
			authoritativeProvider: syntheticFixtureProvider({ log }),
		})

		expect(log.length).toBeGreaterThan(0)
		expect(log.every((query) => typeof query.rawQuery === "string" && query.rawQuery.length > 0)).toBe(true)
		expect(log.every((query) => query.normalizedQuery.length > 0)).toBe(true)
		expect(log.some((query) => query.components.some((component) => component.tag === "locality"))).toBe(true)
	})

	it("reads a refusal from the shipped fixture as a refusal, not a miss", async () => {
		const provider = syntheticFixtureProvider()

		const answer = await provider.lookup({
			rawQuery: "nothing the fixture knows",
			normalizedQuery: "nothing the fixture knows",
			components: [],
		})

		expect(answer.status).toBe(AuthoritativeResponseStatus.Refused)
		expect(answer.matches).toHaveLength(0)
	})
})

describe("#1902: a controlled run configuration is validated before any licensed file is opened", () => {
	it("accepts a factory and a plain object, and refuses anything missing a required piece", async () => {
		const config = {
			adapter: syntheticFixtureAdapter(),
			deps: syntheticFixtureDeps(),
			authoritativeProvider: syntheticFixtureProvider(),
		}

		await expect(resolvePremiseLinkageConfig(config, "fixture")).resolves.toBe(config)
		await expect(resolvePremiseLinkageConfig(() => config, "fixture")).resolves.toBe(config)
		await expect(resolvePremiseLinkageConfig({ adapter: config.adapter }, "fixture")).rejects.toThrow(/fixture/u)
		await expect(resolvePremiseLinkageConfig(undefined, "fixture")).rejects.toThrow(/fixture/u)
	})
})
