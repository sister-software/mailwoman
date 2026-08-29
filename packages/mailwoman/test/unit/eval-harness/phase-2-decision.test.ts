/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the pre-registered phase-2 decision ruler (#1967): the freeze mechanism, the refusals that
 *   keep a blocked lane out of the arithmetic, the three-way decision, and the committed pre-registration's
 *   own consistency with the artifacts it names.
 *
 *   No model, no database, no pipeline — the decision function is graded against synthetic readings and the
 *   loader against temporary copies of the committed files, so every threshold and every refusal is
 *   exercised without a run.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { QueryIntentCode } from "@mailwoman/core/pipeline"
import { mkdtempSync, readFileSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import {
	ABSENCE_PROBE_FREEZE_PATH,
	type AbsenceProbeFreezeRecord,
} from "mailwoman/eval-harness/absence-observation/probe"
import {
	auditPhase2Definition,
	computePhase2Counts,
	decidePhase2,
	describeBar,
	evaluatePhase2Checks,
	instrumentFor,
	loadPhase2Definition,
	PHASE2_DEFINITION_PATH,
	PHASE2_FREEZE_PATH,
	PHASE2_MEASUREMENTS,
	PHASE2_RECEIPT_PATH,
	type Phase2ArtifactPins,
	type Phase2CheckOutcome,
	type Phase2DecisionDefinition,
	type Phase2FreezeRecord,
	type Phase2Measurement,
	type Phase2Reading,
	type Phase2Verdict,
	phase2DefinitionHash,
} from "mailwoman/eval-harness/phase-2-decision/decision"
import { MARKER_PROBE_EXPECTED_CODE } from "mailwoman/eval-harness/phase-2-decision/run"
import { PROBE_FREEZE_PATH, type ProbeFreezeRecord } from "mailwoman/eval-harness/semantic-utility/probe"
import { SEMANTIC_AFFORDS_MECHANISM } from "mailwoman/observations"
import { describe, expect, it } from "vitest"

const definition = loadPhase2Definition()
const freeze = parseJSONStrict<Phase2FreezeRecord>(readFileSync(PHASE2_FREEZE_PATH, "utf8"))

/**
 * The committed receipt's shape, narrowed to what this suite reads. Typing it here rather than importing the runner's
 * `Phase2Receipt` keeps the pure suite free of the module that loads a pipeline.
 */
interface CommittedReceipt {
	decisionID: string
	definitionVersion: string
	definitionSHA256: string
	artifact: Phase2ArtifactPins
	artifactPinDeviations: string[]
	readings: Phase2Reading[]
	checks: Phase2CheckOutcome[]
	verdict: Phase2Verdict
	recorded: boolean
	recordingNote: string
}

/**
 * Write a definition + freeze pair into a scratch directory, so a refusal can be provoked without touching the
 * committed ruler.
 */
function scratchPair(
	mutate: (definition: Phase2DecisionDefinition) => void,
	freezeOverride?: Partial<Phase2FreezeRecord>
): { definitionPath: string; freezePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "phase-2-decision-"))
	const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))

	mutate(copy)

	const definitionPath = join(dir, "decision-definition.json")
	const freezePath = join(dir, "decision-freeze.json")

	writeFileSync(definitionPath, JSON.stringify(copy, null, "\t"))

	writeFileSync(
		freezePath,
		JSON.stringify({ ...freeze, sha256: phase2DefinitionHash(copy), ...freezeOverride }, null, "\t")
	)

	return { definitionPath, freezePath }
}

/**
 * Readings that put every registered check at its committed baseline — the run the ruler's baselines describe.
 */
function baselineReadings(source: Phase2DecisionDefinition = definition): Map<Phase2Measurement, Phase2Reading> {
	const readings = new Map<Phase2Measurement, Phase2Reading>()

	for (const check of source.checks) {
		readings.set(check.measurement, {
			measurement: check.measurement,
			observed: check.baseline.value,
			detail: `synthetic reading at the committed baseline for ${check.id}`,
		})
	}

	return readings
}

function withReading(
	readings: Map<Phase2Measurement, Phase2Reading>,
	measurement: Phase2Measurement,
	observed: number
): Map<Phase2Measurement, Phase2Reading> {
	const override: [Phase2Measurement, Phase2Reading] = [
		measurement,
		{ measurement, observed, detail: `synthetic override to ${observed}` },
	]

	return new Map([...readings, override])
}

function outcomesAt(readings: Map<Phase2Measurement, Phase2Reading>): Phase2CheckOutcome[] {
	return evaluatePhase2Checks(definition, readings)
}

describe("the frozen phase-2 pre-registration (#1967)", () => {
	it("loads, and its content hash matches the committed freeze record", () => {
		expect(phase2DefinitionHash(definition)).toBe(freeze.sha256)
		expect(freeze.decisionID).toBe(definition.decisionID)
		expect(freeze.version).toBe(definition.version)
		expect(freeze.definition).toBe("packages/mailwoman/eval-harness/phase-2-decision/decision-definition.json")
	})

	it("audits clean", () => {
		expect(auditPhase2Definition(definition)).toEqual([])
	})

	it("refuses a definition whose content hash has moved", () => {
		const { definitionPath } = scratchPair((copy) => {
			copy.thresholds.minimumResolutionChecks = 1
		})

		expect(() => loadPhase2Definition(definitionPath, PHASE2_FREEZE_PATH)).toThrow(/content hash .* !== frozen/)
	})

	it("refuses a freeze record pinning another version", () => {
		const { definitionPath, freezePath } = scratchPair(
			(copy) => {
				copy.version = "1.1.0"
			},
			{ version: "1.0.0" }
		)

		expect(() => loadPhase2Definition(definitionPath, freezePath)).toThrow(
			/pins version 1\.0\.0, definition is 1\.1\.0/
		)
	})

	it("refuses a freeze record naming another decision", () => {
		const { definitionPath, freezePath } = scratchPair(() => {}, { decisionID: "phase-3-decision" })

		expect(() => loadPhase2Definition(definitionPath, freezePath)).toThrow(/freeze record names/)
	})
})

describe("what the audit refuses", () => {
	it("refuses a check that names a blocked lane", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))
		const first = copy.checks[0]!

		copy.checks = [...copy.checks, { ...first, id: "sneaked-in", lane: "semantic_breadth" }]

		expect(auditPhase2Definition(copy)).toContainEqual(
			expect.stringContaining("lane semantic_breadth is blocked and registers 1 check(s)")
		)
	})

	it("refuses a blocked lane that registers no planned check", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))
		const blocked = copy.lanes.find((lane) => lane.status === "blocked")!

		blocked.plannedChecks = []

		expect(auditPhase2Definition(copy)).toContainEqual(
			expect.stringContaining("registers no planned check — a lane recorded as blocked without what it will measure")
		)
	})

	it("refuses a blocked lane that names nothing blocking it", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))
		const blocked = copy.lanes.find((lane) => lane.status === "blocked")!

		delete blocked.blockedBy

		expect(auditPhase2Definition(copy)).toContainEqual(expect.stringContaining("names nothing that blocks it"))
	})

	it("refuses a measurable lane with no control check", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))

		copy.checks = copy.checks.filter((check) => !(check.lane === "absence" && check.role === "control"))

		expect(auditPhase2Definition(copy)).toContainEqual(
			expect.stringContaining("lane absence registers no control check — a lane that cannot fail is not a lane")
		)
	})

	it("refuses a target check that registers no tier", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))
		const target = copy.checks.find((check) => check.role === "target")!

		delete target.tier

		expect(auditPhase2Definition(copy)).toContainEqual(
			expect.stringContaining("a target check registers no tier, so no decision could read it")
		)
	})

	it("refuses a control check that registers a tier", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))
		const control = copy.checks.find((check) => check.role === "control")!

		control.tier = "evidence"

		expect(auditPhase2Definition(copy)).toContainEqual(expect.stringContaining("tiers are targets"))
	})

	it("refuses an unregistered measurement", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))

		copy.checks[0]!.measurement = "poi_board.rows_that_felt_right" as Phase2Measurement

		expect(auditPhase2Definition(copy)).toContainEqual(expect.stringContaining("is not registered"))
	})

	it("refuses a bar that cannot be reached", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))
		const check = copy.checks.find((entry) => entry.bar.kind === "at_least")!

		check.bar.value = check.denominator + 1

		expect(auditPhase2Definition(copy)).toContainEqual(
			expect.stringContaining("an unreachable bar can only ever record a miss")
		)
	})

	it("refuses a control tolerance that would let every control miss", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))

		copy.thresholds.controlRegressionTolerance = copy.checks.filter((check) => check.role === "control").length

		expect(auditPhase2Definition(copy)).toContainEqual(expect.stringContaining("the control set would decide nothing"))
	})

	it("refuses a required-lane count that does not equal the measurable lanes", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))

		copy.thresholds.requiredMeasurableLanes = 2

		expect(auditPhase2Definition(copy)).toContainEqual(
			expect.stringContaining("a lane that need not report is one that can go missing unnoticed")
		)
	})

	it("refuses a default-bar row that reads met and names no check", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))
		const met = copy.defaultChangeBar.find((row) => row.state === "met")!

		met.satisfiedBy = []

		expect(auditPhase2Definition(copy)).toContainEqual(
			expect.stringContaining("reads met and names no check — a row asserting itself satisfied is prose")
		)
	})

	it("refuses a default-bar row naming a check that does not exist", () => {
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))

		copy.defaultChangeBar[0]!.satisfiedBy = ["srf-c-99"]

		expect(auditPhase2Definition(copy)).toContainEqual(expect.stringContaining("which is not a check"))
	})
})

describe("reading the registered checks", () => {
	it("refuses a check whose measurement no instrument answered", () => {
		const readings = baselineReadings()

		readings.delete("poi_board.floors_unmet")

		expect(() => evaluatePhase2Checks(definition, readings)).toThrow(
			/an unread measurement is a broken instrument, never a zero/
		)
	})

	it("grades every registered check when every measurement is answered", () => {
		const outcomes = outcomesAt(baselineReadings())

		expect(outcomes).toHaveLength(definition.checks.length)
		expect(outcomes.every((outcome) => outcome.met)).toBe(true)
	})

	it("compares each bar kind the way its name reads", () => {
		expect(describeBar({ kind: "at_least", value: 3 })).toBe("≥ 3")
		expect(describeBar({ kind: "at_most", value: 0 })).toBe("≤ 0")
		expect(describeBar({ kind: "exactly", value: 51 })).toBe("= 51")

		const overCounted = outcomesAt(withReading(baselineReadings(), "poi_board.counted_rows", 52))

		expect(overCounted.find((outcome) => outcome.id === "srf-c-02")!.met).toBe(false)

		const overPassing = outcomesAt(withReading(baselineReadings(), "poi_board.counted_passing", 51))

		expect(overPassing.find((outcome) => outcome.id === "srf-c-03")!.met).toBe(true)
	})

	it("counts the registered checks rather than the ones that answered", () => {
		const counts = computePhase2Counts(definition, [])

		expect(counts.resolutionChecks).toBe(3)
		expect(counts.evidenceChecks).toBe(6)
		expect(counts.controlChecks).toBe(18)
		expect(counts.resolutionMet).toBe(0)
	})
})

describe("the decision the ruler maps to", () => {
	it("reads PROCEED-AS-AUTHORIZED at the committed baselines", () => {
		const verdict = decidePhase2(definition, outcomesAt(baselineReadings()))

		expect(verdict.decision).toBe("PROCEED-AS-AUTHORIZED")
		expect(verdict.misses).toEqual([])
	})

	it("records partial coverage and names the blocked lane on every run", () => {
		const verdict = decidePhase2(definition, outcomesAt(baselineReadings()))

		expect(verdict.coverage).toBe("partial")
		expect(verdict.blockedLanes).toEqual(["semantic_breadth"])
		expect(verdict.reasons).toContainEqual(expect.stringContaining("blocked lanes not measured by this ruler"))
		expect(verdict.reasons).toContainEqual(expect.stringContaining("issues/1980"))
	})

	it("checks control misses FIRST — a control regression stops a run whose targets all hold", () => {
		const readings = withReading(baselineReadings(), "semantic_utility.treatment.control_holds", 5)
		const verdict = decidePhase2(definition, outcomesAt(readings))

		expect(verdict.decision).toBe("STOP-REDESIGN")
		expect(verdict.counts.resolutionMet).toBe(3)
		expect(verdict.counts.evidenceMet).toBe(6)
		expect(verdict.reasons).toContainEqual("control misses exceed tolerance")
	})

	it("reads EVIDENCE-ONLY when the observation surface holds and recognition does not", () => {
		const readings = withReading(baselineReadings(), "semantic_utility.treatment.primary_passes", 1)
		const verdict = decidePhase2(definition, outcomesAt(readings))

		expect(verdict.decision).toBe("EVIDENCE-ONLY")
		expect(verdict.counts.evidenceMet).toBe(6)
		expect(verdict.counts.resolutionMet).toBe(2)
	})

	it("reads STOP-REDESIGN when the evidence bar is not reached, whatever recognition did", () => {
		const readings = withReading(baselineReadings(), "absence_probe.targets_fired", 0)
		const verdict = decidePhase2(definition, outcomesAt(readings))

		expect(verdict.decision).toBe("STOP-REDESIGN")
		expect(verdict.counts.resolutionMet).toBe(3)
		expect(verdict.reasons).toContainEqual("the evidence bar was not reached")
	})

	it("stops when a measurable lane did not report at all", () => {
		const outcomes = outcomesAt(baselineReadings()).filter((outcome) => outcome.lane !== "absence")
		const verdict = decidePhase2(definition, outcomes)

		expect(verdict.decision).toBe("STOP-REDESIGN")
		expect(verdict.reasons).toContainEqual(expect.stringContaining("an unreported lane is not a passing one"))
	})

	it("reports an artifact pin deviation without letting it change the decision", () => {
		const outcomes = outcomesAt(baselineReadings())
		const pinned = decidePhase2(definition, outcomes)
		const deviated = decidePhase2(definition, outcomes, { deviations: ['weightsVersion: observed "9.2.0"'] })

		expect(pinned.comparability).toBe("pinned")
		expect(deviated.comparability).toBe("deviated")
		expect(deviated.decision).toBe(pinned.decision)
		expect(deviated.pinDeviations).toHaveLength(1)
	})

	it("reports the unmet default-change rows without letting them change the decision", () => {
		const verdict = decidePhase2(definition, outcomesAt(baselineReadings()))

		expect(verdict.decision).toBe("PROCEED-AS-AUTHORIZED")
		expect(verdict.defaultChangeBarUnmetRows).toEqual([1, 2, 3, 4, 5, 6, 7, 9])
		expect(verdict.reasons).toContainEqual(expect.stringContaining("this decision authorizes no default change"))

		// The same measurements against a definition whose default bar reads met on every row still decide the same
		// thing — the register is recorded, never read.
		const copy = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(PHASE2_DEFINITION_PATH, "utf8"))

		for (const row of copy.defaultChangeBar) {
			row.state = "met"
			row.satisfiedBy = [copy.checks[0]!.id]
		}

		const asIfMet = decidePhase2(copy, evaluatePhase2Checks(copy, baselineReadings(copy)))

		expect(asIfMet.decision).toBe(verdict.decision)
		expect(asIfMet.defaultChangeBarUnmetRows).toEqual([])
	})
})

describe("the pre-registration agrees with the artifacts it names", () => {
	it("pins the semantic-utility ruler's committed hash", () => {
		const probeFreeze = parseJSONStrict<ProbeFreezeRecord>(readFileSync(PROBE_FREEZE_PATH, "utf8"))

		expect(definition.artifactPins.semanticUtilityDefinitionSHA256).toBe(probeFreeze.sha256)
	})

	it("pins the absence ruler's committed hash", () => {
		const absenceFreeze = parseJSONStrict<AbsenceProbeFreezeRecord>(readFileSync(ABSENCE_PROBE_FREEZE_PATH, "utf8"))

		expect(definition.artifactPins.absenceDefinitionSHA256).toBe(absenceFreeze.sha256)
	})

	it("registers a marker code and mechanism the runtime vocabulary actually carries", () => {
		expect(definition.markerProbe.expectedCode).toBe(QueryIntentCode.POICategory)
		expect(definition.markerProbe.expectedCode).toBe(MARKER_PROBE_EXPECTED_CODE)
		expect(definition.markerProbe.expectedMechanism).toBe(SEMANTIC_AFFORDS_MECHANISM)
	})

	it("routes every registered measurement to an instrument", () => {
		for (const check of definition.checks) {
			expect(instrumentFor(check.measurement)).toBe(PHASE2_MEASUREMENTS[check.measurement])
		}
	})

	it("registers the four phase-2 lanes, exactly one of them blocked", () => {
		expect(definition.lanes.map((lane) => lane.id)).toEqual([
			"recognition",
			"semantic_breadth",
			"absence",
			"surface_inertness",
		])

		expect(definition.lanes.filter((lane) => lane.status === "blocked").map((lane) => lane.blockedBy)).toEqual([
			"https://github.com/sister-software/mailwoman/issues/1980",
		])
	})

	it("records the integration record's nine default-change rows in order", () => {
		expect(definition.defaultChangeBar).toHaveLength(9)
		expect(definition.defaultChangeBar.map((row) => row.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
	})

	it("names a merged receipt or a committed artifact for every baseline", () => {
		for (const check of definition.checks) {
			expect(check.baseline.reference).not.toBe("")
			expect(["merged-pr-receipt", "committed-receipt", "committed-artifact"]).toContain(check.baseline.source)
		}
	})
})

describe("the committed receipt", () => {
	const receipt = parseJSONStrict<CommittedReceipt>(readFileSync(PHASE2_RECEIPT_PATH, "utf8"))

	it("was measured against this exact ruler", () => {
		expect(receipt.decisionID).toBe(definition.decisionID)
		expect(receipt.definitionVersion).toBe(definition.version)
		expect(receipt.definitionSHA256).toBe(freeze.sha256)
	})

	it("carries every registered check, and no other", () => {
		expect(receipt.checks.map((check) => check.id).toSorted()).toEqual(
			definition.checks.map((check) => check.id).toSorted()
		)
	})

	it("carries the artifact identity the ruler pins, with every difference named", () => {
		expect(receipt.artifact.poiLayerManifestVersion).toBe(definition.artifactPins.poiLayerManifestVersion)
		expect(receipt.artifact.weightsVersion).toBe(definition.artifactPins.weightsVersion)
		expect(receipt.artifact.geographicModelVersion).toBe(definition.artifactPins.geographicModelVersion)
		expect(receipt.artifactPinDeviations).toEqual([])
		expect(receipt.verdict.comparability).toBe("pinned")
	})

	it("records partial coverage and states that the recording is not its own", () => {
		expect(receipt.verdict.coverage).toBe("partial")
		expect(receipt.verdict.blockedLanes).toEqual(["semantic_breadth"])
		expect(receipt.recorded).toBe(false)
		expect(receipt.recordingNote).toBe(definition.recordingNote)
	})

	it("reaches the same decision when its own readings are replayed through the ruler", () => {
		const replayed = new Map<Phase2Measurement, Phase2Reading>(
			receipt.readings.map((reading) => [reading.measurement, reading])
		)

		const verdict = decidePhase2(definition, evaluatePhase2Checks(definition, replayed))

		expect(verdict.decision).toBe(receipt.verdict.decision)
		expect(verdict.counts).toEqual(receipt.verdict.counts)
	})
})
