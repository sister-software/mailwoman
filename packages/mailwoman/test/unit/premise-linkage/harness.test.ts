import { readLocalTextFile, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
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

describe(": synthetic fixtures exercise exact, wrong, refused and ambiguous in both required arms", () => {
	it("grades every fixture row through both arms, and the authoritative arm produces all four outcomes", async () => {
		const run = await syntheticRun()
		const fixtureRows = await collectRows(syntheticFixtureAdapter())

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

		expect(authoritative.overall.exactOverEligible.of).toBeLessThan(authoritative.rowsRead)
	})
})

describe(": the report prints every numerator and denominator", () => {
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

		expect(comparison.improved.n).toBeGreaterThan(0)
		expect(comparison.regressed.n).toBeGreaterThan(0)
	})

	it("moves refusals into the eligible denominator only when the policy required a unique answer", async () => {
		const permitted = await syntheticRun({ policy: PremiseLinkagePolicy.AbstainPermitted })
		const required = await syntheticRun({ policy: PremiseLinkagePolicy.UniqueRequired })

		const permittedOpen = armNamed(permitted.report, OPEN_ARM_NAME)
		const requiredOpen = armNamed(required.report, OPEN_ARM_NAME)

		expect(permittedOpen.overall.exactOverEligible).toEqual({ n: 0, of: 0 })

		expect(requiredOpen.overall.exactOverEligible.of).toBeGreaterThan(0)
		expect(requiredOpen.overall.refusedOverAll).toEqual(permittedOpen.overall.refusedOverAll)

		const openRows = required.rows.filter((row) => row.providerName === "none")

		expect(openRows.every((row) => row.outcome !== PremiseLinkageOutcome.Wrong)).toBe(true)
	})
})

describe(": reordering the private input does not change aggregate results", () => {
	it("produces deep-equal aggregates from the same rows fed in reverse", async () => {
		const rows = await collectRows(syntheticFixtureAdapter())
		const forward = await syntheticRun({ adapter: listAdapter("forward", rows) })
		const reversed = await syntheticRun({ adapter: listAdapter("reversed", rows.toReversed()) })

		expect(reversed.report).toEqual(forward.report)
	})
})

describe(": two runs with different salts cannot be joined by their case identifiers", () => {
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

describe(": the public-report writer refuses an injected disclosure", () => {
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
		await using directoryDirectory = await temporaryDirectory("premise-linkage-")
		const directory = directoryDirectory.path
		const target = directory("report.json")
		const injected = structuredClone(run.report)

		injected.arms[0]!.providerName = "12 Downing Terrace"

		await expect(writePremiseLinkageReport(target, { ...run, report: injected })).rejects.toThrow(/refusing to write/u)
		await expect(readLocalTextFile(target)).rejects.toThrow(/ENOENT/u)
	})

	it("writes the suppressed report when every check passes", async () => {
		const run = await syntheticRun()
		await using directoryDirectory = await temporaryDirectory("premise-linkage-")
		const directory = directoryDirectory.path
		const target = directory("report.json")
		const written = await writePremiseLinkageReport(target, run)
		const roundTripped = await readLocalJSONFile<PremiseLinkageReport>(target)

		expect(roundTripped).toEqual(written)
	})
})

describe(": small result cells are suppressed according to the configured minimum", () => {
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

describe(": the Mailwoman-only arm uses the production pipeline, unchanged", () => {
	it("consults the provider once per row, not twice — the open arm is handed none", async () => {
		const log: AuthoritativeQuery[] = []
		const rows = await collectRows(syntheticFixtureAdapter())

		await syntheticRun({
			adapter: listAdapter("logged", rows),
			authoritativeProvider: syntheticFixtureProvider({ log }),
		})

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

		expect(openRows.every((row) => row.failureCategory === PremiseLinkageFailureCategory.ArmAssertsNoIdentifier)).toBe(
			true
		)
	})
})

describe(": the authoritative arm consumes the provider interface", () => {
	it("Hands the fixture provider the assembled query, once per row", async () => {
		const log: AuthoritativeQuery[] = []
		const rows = await collectRows(syntheticFixtureAdapter())

		await syntheticRun({
			adapter: listAdapter("logged", rows),
			authoritativeProvider: syntheticFixtureProvider({ log }),
		})

		expect(log.length).toBeGreaterThan(0)
		expect(log.every((query) => typeof query.rawQuery === "string" && query.rawQuery.length)).toBe(true)
		expect(log.every((query) => query.normalizedQuery.length)).toBe(true)
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

describe(": a controlled run configuration is validated before any licensed file is opened", () => {
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
