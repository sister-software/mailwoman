/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the pre-registered semantic-utility probe (#1928): the freeze mechanism, the refusals, the
 *   metric arithmetic, and the committed pre-registration's own consistency with the board it references.
 *
 *   No model, no database, no pipeline — the decision function is graded against synthetic counts and the
 *   loader against temporary copies of the committed files, so every threshold is exercised without a run.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import type { POIIntent, POIResult } from "@mailwoman/core/pipeline"
import { POI_BOARD_FIXTURES, type POIBoardFixture, type POIBoardOutcome } from "mailwoman/eval-harness/poi-board"
import {
	auditProbeDefinition,
	canonicalJSON,
	computeProbeCounts,
	decideProbe,
	gradeWithComparator,
	loadProbeDefinition,
	POI_OUTCOME_SHAPES,
	type POIOutcomeShape,
	poiOutcomeShape,
	PROBE_BASELINE_RECEIPT_PATH,
	PROBE_DEFINITION_PATH,
	PROBE_FREEZE_PATH,
	type ProbeComparatorName,
	type ProbeCounts,
	type ProbeFreezeRecord,
	type ProbeRowOutcome,
	probeDefinitionHash,
	resolveControlRows,
	type SemanticProbeDefinition,
} from "mailwoman/eval-harness/semantic-utility/probe"
import { join } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const committed = await Array.fromAsync(JSONSpliterator.fromAsync<POIBoardFixture>(POI_BOARD_FIXTURES))
const definition = await loadProbeDefinition()
const freeze = await readLocalJSONFile<ProbeFreezeRecord>(PROBE_FREEZE_PATH)

interface BaselineReceipt {
	probeID: string
	definitionVersion: string
	definitionSHA256: string
	arm: string
	counts: ProbeCounts
	rows: ProbeRowOutcome[]
	verdict: { decision: string }
}

const receipt = await readLocalJSONFile<BaselineReceipt>(PROBE_BASELINE_RECEIPT_PATH)

/**
 * Write a definition + freeze pair into a scratch directory, so a refusal can be provoked without touching the
 * committed ruler.
 */
async function scratchPair(
	mutate: (definition: SemanticProbeDefinition) => void,
	freezeOverride?: Partial<ProbeFreezeRecord>
): Promise<{ definitionPath: string; freezePath: string }> {
	const dir = fixtures.use(await temporaryDirectory("semantic-utility-probe-")).path
	const copy = await readLocalJSONFile<SemanticProbeDefinition>(PROBE_DEFINITION_PATH)

	mutate(copy)

	const definitionPath = join(dir, "probe-definition.json")
	const freezePath = join(dir, "probe-freeze.json")

	await writeLocalJSONFile(copy, definitionPath)
	await writeLocalJSONFile({ ...freeze, ...freezeOverride }, freezePath)

	return { definitionPath, freezePath }
}

const pharmacyIntent: POIIntent = { subject: { kind: "category", categoryIDs: ["pharmacy"], matched: "pharmacy" } }

const pharmacyResult: POIResult = {
	name: "Some Pharmacy",
	categoryID: "pharmacy",
	brandWikidata: null,
	latitude: 39.7392,
	longitude: -104.9903,
	country: "US",
	confidence: 0.9,
	gersID: "gers-1",
}

function counts(overrides: Partial<ProbeCounts> = {}): ProbeCounts {
	return {
		primaryNumerator: 0,
		primaryDenominator: 4,
		diagnosticNumerator: 1,
		diagnosticDenominator: 4,
		controlHoldNumerator: 6,
		controlDenominator: 6,
		...overrides,
	}
}

describe("the committed pre-registration", () => {
	it("loads, which means its content hash still matches the freeze record", async () => {
		expect(probeDefinitionHash(definition)).toBe(freeze.sha256)
		expect(freeze.probeID).toBe(definition.probeID)
		expect(freeze.version).toBe(definition.version)
	})

	it("audits clean", async () => {
		expect(auditProbeDefinition(definition)).toEqual([])
	})

	it("registers four target rows and six control rows across both groups", async () => {
		expect(definition.targetRows).toHaveLength(4)
		expect(definition.controlRows).toHaveLength(6)
		expect(definition.controlRows.filter((row) => row.group === "same_category")).toHaveLength(3)
		expect(definition.controlRows.filter((row) => row.group === "adjacent")).toHaveLength(3)
	})

	it("resolves every control row against the committed board file, byte-for-byte", async () => {
		const resolved = resolveControlRows(definition, committed)

		expect(resolved.map((row) => row.id)).toEqual(definition.controlRows.map((row) => row.id))
	})

	it("copies each target row's anchor and expectation from the committed row it names", async () => {
		const byID = new Map(committed.map((fixture) => [fixture.id, fixture]))

		for (const target of definition.targetRows) {
			const source = byID.get(target.anchorFrom)

			expect(source, `${target.id} names ${target.anchorFrom}`).toBeDefined()
			expect(canonicalJSON(target.expect)).toBe(canonicalJSON(source!.expect))
		}
	})

	it("states a missing distinction and a measured baseline shape on every target row", async () => {
		for (const target of definition.targetRows) {
			expect(target.missingDistinction.length).toBeGreaterThan(0)
			expect(POI_OUTCOME_SHAPES).toContain(target.baselineShape)
		}
	})

	it("gives every control row the failure it guards", async () => {
		for (const control of definition.controlRows) {
			expect(control.guards.length, control.id).toBeGreaterThan(0)
		}
	})
})

describe("the freeze mechanism", () => {
	it("refuses a definition whose content moved without the hash record moving", async () => {
		const paths = await scratchPair((copy) => {
			copy.thresholds.minimumPrimaryNumerator = 1
		})

		await expect(loadProbeDefinition(paths.definitionPath, paths.freezePath)).rejects.toThrow(/content hash/u)
	})

	it("refuses a row edit just as loudly as a threshold edit", async () => {
		const paths = await scratchPair((copy) => {
			copy.targetRows[0]!.query = "where can i pick up a prescription near Boulder CO"
		})

		await expect(loadProbeDefinition(paths.definitionPath, paths.freezePath)).rejects.toThrow(/content hash/u)
	})

	it("refuses a version bump that does not carry a new hash", async () => {
		const paths = await scratchPair((copy) => {
			copy.version = "1.1.0"
		})

		await expect(loadProbeDefinition(paths.definitionPath, paths.freezePath)).rejects.toThrow(/pins version/u)
	})

	it("refuses a freeze record that names another probe", async () => {
		const paths = await scratchPair(() => undefined, { probeID: "some-other-probe" })

		await expect(loadProbeDefinition(paths.definitionPath, paths.freezePath)).rejects.toThrow(/names probe/u)
	})
})

describe("execution refusals", () => {
	it("refuses an unregistered comparator", async () => {
		const fixture = definition.targetRows[0]!
		const outcome: POIBoardOutcome = { path: "full" }
		// A name the conformance layer registers and this probe does not — the exact way a definition acquires one.
		const unregistered = "resolution_identity" as ProbeComparatorName

		expect(() => gradeWithComparator(unregistered, fixture, outcome)).toThrow(/unregistered outcome comparator/u)
	})

	it("refuses a control row that is not in its committed file", async () => {
		const withoutControl = committed.filter((fixture) => fixture.id !== definition.controlRows[0]!.id)

		expect(() => resolveControlRows(definition, withoutControl)).toThrow(/is not in/u)
	})

	it("refuses a control row whose committed contents have moved", async () => {
		const drifted = committed.map((fixture) =>
			fixture.id === definition.controlRows[0]!.id ? { ...fixture, query: "pharmacy near Boulder CO" } : fixture
		)

		expect(() => resolveControlRows(definition, drifted)).toThrow(/has moved/u)
	})

	it("refuses a denominator that disagrees with the registered row count", async () => {
		const copy = await readLocalJSONFile<SemanticProbeDefinition>(PROBE_DEFINITION_PATH)
		copy.primaryMetric.denominator = 5

		expect(auditProbeDefinition(copy)).toContain("primaryMetric.denominator 5 !== 4 registered target rows")
	})

	it("refuses a threshold that is not a whole row count", async () => {
		const copy = await readLocalJSONFile<SemanticProbeDefinition>(PROBE_DEFINITION_PATH)
		copy.thresholds.minimumPrimaryNumerator = 2.5

		expect(auditProbeDefinition(copy).join("\n")).toMatch(/thresholds\.minimumPrimaryNumerator is 2\.5/u)
	})

	it("refuses a bar no run could reach", async () => {
		const copy = await readLocalJSONFile<SemanticProbeDefinition>(PROBE_DEFINITION_PATH)
		copy.thresholds.minimumPrimaryNumerator = 9

		expect(auditProbeDefinition(copy).join("\n")).toMatch(/exceeds the primary denominator/u)
	})

	it("refuses a control tolerance that lets every control row move", async () => {
		const copy = await readLocalJSONFile<SemanticProbeDefinition>(PROBE_DEFINITION_PATH)
		copy.thresholds.controlRegressionTolerance = 6

		expect(auditProbeDefinition(copy).join("\n")).toMatch(/would decide nothing/u)
	})

	it("refuses a control set with only one group", async () => {
		const copy = await readLocalJSONFile<SemanticProbeDefinition>(PROBE_DEFINITION_PATH)
		copy.controlRows = copy.controlRows.filter((row) => row.group === "same_category")
		copy.controlMetric.denominator = copy.controlRows.length

		expect(auditProbeDefinition(copy).join("\n")).toMatch(/control group "adjacent" has no rows/u)
	})
})

describe("the outcome-shape vocabulary", () => {
	it("names a shape for every reachable pipeline outcome", async () => {
		expect(poiOutcomeShape({ path: "full" })).toBe("no_poi_branch")
		expect(poiOutcomeShape({ path: "fast-path" })).toBe("no_poi_branch")
		expect(poiOutcomeShape({ path: "poi" })).toBe("no_poi_branch")

		expect(poiOutcomeShape({ path: "poi", poiIntent: { type: "abstain", reason: "anchor_required" } })).toBe(
			"poi_abstain"
		)

		expect(poiOutcomeShape({ path: "poi", poiIntent: { type: "intent", intent: pharmacyIntent } })).toBe(
			"poi_intent_no_results"
		)

		expect(poiOutcomeShape({ path: "poi", poiIntent: { type: "intent", intent: pharmacyIntent, results: [] } })).toBe(
			"poi_intent_no_results"
		)

		expect(
			poiOutcomeShape({
				path: "poi",
				poiIntent: { type: "intent", intent: pharmacyIntent, results: [pharmacyResult] },
			})
		).toBe("poi_intent_results")
	})
})

describe("the metric arithmetic", () => {
	function outcome(
		id: string,
		role: "target" | "control",
		pass: boolean,
		shape: POIOutcomeShape = "no_poi_branch"
	): ProbeRowOutcome {
		return {
			id,
			role,
			query: id,
			shape,
			grade: { id, query: id, expectKind: "results", pass, detail: "" },
		}
	}

	it("counts over the registered denominators, never over the rows that answered", async () => {
		const measured = computeProbeCounts(definition, [
			outcome("sem-act-us-01", "target", true, "poi_intent_results"),
			outcome("sem-act-us-02", "target", false),
		])

		expect(measured.primaryNumerator).toBe(1)
		expect(measured.primaryDenominator).toBe(4)
		expect(measured.diagnosticNumerator).toBe(1)
		expect(measured.controlDenominator).toBe(6)
	})

	it("reads the diagnostic numerator off the shape, not off the grade", async () => {
		const measured = computeProbeCounts(definition, [
			outcome("sem-act-us-01", "target", false, "poi_intent_results"),
			outcome("sem-act-fr-01", "target", false, "poi_abstain"),
			outcome("sem-act-mx-01", "target", false, "no_poi_branch"),
		])

		expect(measured.primaryNumerator).toBe(0)
		expect(measured.diagnosticNumerator).toBe(2)
	})
})

describe("the decision", () => {
	it("records STOP-REDESIGN for the baseline arm compared against its own frozen baseline", async () => {
		expect(decideProbe(definition, counts()).decision).toBe("STOP-REDESIGN")
	})

	it("records GO at the frozen primary bar", async () => {
		const verdict = decideProbe(definition, counts({ primaryNumerator: 3, diagnosticNumerator: 3 }))

		expect(verdict.decision).toBe("GO")
		expect(verdict.primaryDelta).toBe(3)
	})

	it("holds GO back one row short of the bar", async () => {
		expect(decideProbe(definition, counts({ primaryNumerator: 2, diagnosticNumerator: 2 })).decision).toBe(
			"STOP-REDESIGN"
		)
	})

	it("records DIAGNOSTIC-ONLY when only the routing bar is reached", async () => {
		const verdict = decideProbe(definition, counts({ primaryNumerator: 0, diagnosticNumerator: 3 }))

		expect(verdict.decision).toBe("DIAGNOSTIC-ONLY")
		expect(verdict.diagnosticDelta).toBe(2)
	})

	it("holds DIAGNOSTIC-ONLY back when routing rises without reaching the bar", async () => {
		expect(decideProbe(definition, counts({ diagnosticNumerator: 2 })).decision).toBe("STOP-REDESIGN")
	})

	it("stops on a control regression even when the primary bar is cleared", async () => {
		const verdict = decideProbe(
			definition,
			counts({ primaryNumerator: 4, diagnosticNumerator: 4, controlHoldNumerator: 5 })
		)

		expect(verdict.decision).toBe("STOP-REDESIGN")
		expect(verdict.controlRegressions).toBe(1)
		expect(verdict.reasons.at(-1)).toMatch(/control regressions exceed tolerance/u)
	})

	it("prints every count with its denominator, its baseline and its bar", async () => {
		const verdict = decideProbe(definition, counts({ primaryNumerator: 3, diagnosticNumerator: 3 }))

		expect(verdict.reasons[0]).toBe("primary 3/4 (baseline 0, delta +3; bars 3 and +3)")
		expect(verdict.reasons[1]).toBe("diagnostic 3/4 (baseline 1, delta +2; bars 3 and +2)")
		expect(verdict.reasons[2]).toBe("control 6/6 (baseline 6, regressions 0; tolerance 0)")
	})
})

describe("the committed baseline receipt", () => {
	it("was measured against this version of the pre-registration", async () => {
		expect(receipt.probeID).toBe(definition.probeID)
		expect(receipt.definitionVersion).toBe(definition.version)
		expect(receipt.definitionSHA256).toBe(freeze.sha256)
		expect(receipt.arm).toBe("baseline")
	})

	it("carries the numbers the frozen baseline block states", async () => {
		expect(receipt.counts.primaryNumerator).toBe(definition.baseline.primaryNumerator)
		expect(receipt.counts.diagnosticNumerator).toBe(definition.baseline.diagnosticNumerator)
		expect(receipt.counts.controlHoldNumerator).toBe(definition.baseline.controlHoldNumerator)
	})

	it("records every registered row once", async () => {
		expect(receipt.rows.map((row) => row.id).toSorted()).toEqual(
			[...definition.targetRows, ...definition.controlRows].map((row) => row.id).toSorted()
		)
	})

	it("records the per-row baseline shape the pre-registration froze", async () => {
		const shapeByID = new Map(receipt.rows.map((row) => [row.id, row.shape]))

		for (const target of definition.targetRows) {
			expect(shapeByID.get(target.id), target.id).toBe(target.baselineShape)
		}
	})

	it("records STOP-REDESIGN, because a baseline compared against itself moves nothing", async () => {
		expect(receipt.verdict.decision).toBe("STOP-REDESIGN")
	})
})
