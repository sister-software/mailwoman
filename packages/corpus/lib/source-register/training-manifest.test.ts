/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the frozen source record's reproducibility, its decision lookup and its sensitivity to source changes.
 *
 *   Two builds over identical inputs must produce the same manifest so readers can compare them.
 *   A source, grant, row count or recipe change must change the digest.
 *   Each source's decision is found through its register inputs in `corpus-source-inputs.json`,
 *   whatever its rows' `license` label reads.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import {
	LicenseReviewState,
	OperationPermission,
	PermissionBasis,
	type LicenseDecision,
} from "@mailwoman/core/license/decision"
import { describe, expect, it } from "vitest"

import {
	auditTrainingManifest,
	freezeTrainingManifest,
	SourceOperation,
	sourcesNotPermitting,
	TrainingDecisionGapReason,
	trainingManifestDigest,
} from "#source-register"
import { indexCorpusSourceInputs, type CorpusSourceInputsFile } from "#source-register/corpus-inputs"
import type { SourceDecisionTable } from "#source-register/training-manifest"

const elected: LicenseDecision = {
	licenseID: "testland-open-data",
	state: LicenseReviewState.Elected,
	electedTerms: "Testland Open Data Licence 1.0",
	spdx: "etalab-2.0",
	retrievedCopy: "data/licenses/testland-1.0.txt",
	electedBecause: "the only grant the publisher offers",
	operations: {
		[SourceOperation.Fetch]: {
			permission: OperationPermission.Permitted,
			basis: PermissionBasis.PublisherGrant,
			because: "§2",
		},
		[SourceOperation.Train]: {
			permission: OperationPermission.Permitted,
			basis: PermissionBasis.PublisherGrant,
			because: "§3",
		},
	},
}

const streetNames: LicenseDecision = {
	licenseID: "testland-street-names",
	state: LicenseReviewState.Elected,
	electedTerms: "Testland Street Names Terms",
	retrievedCopy: "data/licenses/testland-streets.txt",
	electedBecause: "the street register's own grant",
	operations: {
		[SourceOperation.Transform]: {
			permission: OperationPermission.Permitted,
			basis: PermissionBasis.PublisherGrant,
			because: "§1",
		},
		[SourceOperation.Train]: {
			permission: OperationPermission.Permitted,
			basis: PermissionBasis.PublisherGrant,
			because: "§4",
		},
	},
}

const unchecked: LicenseDecision = {
	licenseID: "unchecked-national-terms-zz-ministry",
	state: LicenseReviewState.Unchecked,
	publisherStatement: "CHECK NATIONAL / DATASET TERMS",
	note: "nobody opened the terms",
}

function input(registerSource: string, license: string) {
	return { registerSource, license, reads: `${registerSource} addresses` }
}

const sourceTable: CorpusSourceInputsFile = {
	sources: {
		"zz-health-1": { inputs: [input("zz-health-1", elected.licenseID)] },
		"zz-business-1": { inputs: [input("zz-business-1", unchecked.licenseID)] },
		"rendered-zz": {
			aliases: ["synth-zz"],
			inputs: [input("zz-health-1", elected.licenseID), input("zz-streets-1", streetNames.licenseID)],
		},
		"spliced-zz": {
			inputs: [input("zz-health-1", elected.licenseID), input("zz-business-1", unchecked.licenseID)],
			history: [{ corpora: ["v0.0.9"], inputs: [input("zz-health-1", elected.licenseID)], because: "fixture" }],
		},
		"zz-withdrawn-1": { inputs: [input("zz-withdrawn-1", "withdrawn-terms-zz")] },
		"invented-zz": { inputs: [], authored: ["a hand-written word list"] },
	},
}

const decisionTable: SourceDecisionTable = {
	decisions: new Map([elected, streetNames, unchecked].map((decision) => [decision.licenseID, decision])),
	inputs: indexCorpusSourceInputs(sourceTable),
}

function freeze(overrides: Partial<Parameters<typeof freezeTrainingManifest>[0]> = {}) {
	return freezeTrainingManifest({
		corpusVersion: "v0.1.0",
		builtAt: "2026-09-20T12:00:00.000Z",
		profile: "release-eligible",
		rowsBySource: new Map([
			["zz-health-1", { rows: 400, license: "etalab-2.0" }],
			["zz-business-1", { rows: 900, license: "LicenseRef-unchecked-national-terms-zz-ministry" }],
		]),
		decisionTable,
		refused: new Map([["zz-transport-1", ["no coverage has been measured"]]]),
		...overrides,
	})
}

function recordOf(source: string, license: string, corpusVersion = "v0.1.0") {
	return freeze({ corpusVersion, rowsBySource: new Map([[source, { rows: 10, license }]]) }).sources[0]!
}

describe("freezeTrainingManifest", () => {
	it("produces a byte-identical manifest from identical inputs", () => {
		expect(stringifyJSON(freeze())).toBe(stringifyJSON(freeze()))
	})

	it("orders sources by rows so the largest contributor reads first", () => {
		expect(freeze().sources.map((record) => record.source)).toEqual(["zz-business-1", "zz-health-1"])
		expect(freeze().totalRows).toBe(1300)
	})

	it("finds an elected decision for a source whose rows carry its SPDX id rather than its licenseID", () => {
		const record = recordOf("zz-health-1", "etalab-2.0")

		expect(record.decision).toEqual({
			licenseID: "testland-open-data",
			state: LicenseReviewState.Elected,
			electedTerms: "Testland Open Data Licence 1.0",
			permitted: [SourceOperation.Fetch, SourceOperation.Train],
		})

		expect(record.decisionGap).toBeUndefined()
	})

	it("finds the unchecked decision for a source whose rows carry a LicenseRef- id", () => {
		const record = recordOf("zz-business-1", "LicenseRef-unchecked-national-terms-zz-ministry")

		expect(record.decision?.licenseID).toBe("unchecked-national-terms-zz-ministry")
		expect(record.decision?.state).toBe(LicenseReviewState.Unchecked)
		expect(record.decision?.permitted).toEqual([])
	})

	it("combines the decisions of a source whose rows carry several ids joined by AND", () => {
		// Looked up under its alias, as an older corpus stores it.
		const record = recordOf("synth-zz", "LicenseRef-testland-street-names AND etalab-2.0")

		expect(record.decision?.licenseID).toBe("testland-open-data AND testland-street-names")
		expect(record.decision?.state).toBe(LicenseReviewState.Elected)
		expect(record.decision?.electedTerms).toBe("Testland Open Data Licence 1.0 AND Testland Street Names Terms")
		// Only an operation every grant permits survives the intersection.
		expect(record.decision?.permitted).toEqual([SourceOperation.Train])

		expect(record.decision?.inputs?.map((entry) => entry.licenseID)).toEqual([
			"testland-open-data",
			"testland-street-names",
		])
	})

	it("reads a combination with any unelected decision as unelected, and keeps each input's own reading", () => {
		const record = recordOf("spliced-zz", "LicenseRef-unchecked-national-terms-zz-ministry AND etalab-2.0")

		expect(record.decision?.state).toBe(LicenseReviewState.Unchecked)
		expect(record.decision?.electedTerms).toBeNull()
		expect(record.decision?.permitted).toEqual([])

		expect(record.decision?.inputs?.map((entry) => entry.state)).toEqual([
			LicenseReviewState.Elected,
			LicenseReviewState.Unchecked,
		])
	})

	it("reads a corpus named in a mapping's history against the inputs that corpus was built from", () => {
		const record = recordOf("spliced-zz", "etalab-2.0", "v0.0.9")

		expect(record.decision?.state).toBe(LicenseReviewState.Elected)
		expect(record.decision?.inputs).toBeUndefined()
	})

	it("records an unmapped source as a gap rather than a decision the register lacked", () => {
		const record = recordOf("wof-admin", "CC0-1.0")

		expect(record.decision).toBeNull()
		expect(record.decisionGap).toEqual({ reason: TrainingDecisionGapReason.Unmapped })
		expect(record.license).toBe("CC0-1.0")
	})

	it("records no decision, naming the licenseID, for a mapping that points at one the register lacks", () => {
		const record = recordOf("zz-withdrawn-1", "LicenseRef-withdrawn-terms-zz")

		expect(record.decision).toBeNull()

		expect(record.decisionGap).toEqual({
			reason: TrainingDecisionGapReason.MissingDecision,
			licenseIDs: ["withdrawn-terms-zz"],
		})
	})

	it("records a source mapped to authored inputs alone as having no register decision", () => {
		expect(recordOf("invented-zz", "LicenseRef-authored").decisionGap).toEqual({
			reason: TrainingDecisionGapReason.NoRegisterInput,
		})
	})

	for (const [what, overrides] of [
		["a source's row count", { rowsBySource: new Map([["zz-health-1", { rows: 401, license: "etalab-2.0" }]]) }],
		["the corpus version", { corpusVersion: "v0.2.0" }],
		["the build profile", { profile: "exploratory" }],
		["a refused source's reasons", { refused: new Map([["zz-transport-1", ["no address role is resolved"]]]) }],
		[
			"an elected grant's permitted operations",
			{
				decisionTable: {
					...decisionTable,
					decisions: new Map([
						[elected.licenseID, { ...elected, operations: {} } as LicenseDecision],
						[unchecked.licenseID, unchecked],
					]),
				},
			},
		],
	] as const) {
		it(`changes the digest when ${what} moves`, () => {
			expect(freeze(overrides).contentDigest).not.toBe(freeze().contentDigest)
		})
	}
})

describe("auditTrainingManifest", () => {
	it("accepts a manifest its own freeze produced", () => {
		expect(auditTrainingManifest(freeze())).toEqual([])
	})

	it("refuses a manifest edited after its build", () => {
		// The digest is what makes this record frozen rather than merely written.
		// The source register's digest detects hand edits to generated artifacts.
		// This test checks that protection on the manifest too.
		const edited = freeze()

		edited.sources[0]!.rows = 1

		expect(auditTrainingManifest(edited)).toContain(
			"the manifest's content digest does not match its contents, so something edited it after its build"
		)
	})

	it("refuses a source listed with no rows", () => {
		const empty = freeze({ rowsBySource: new Map([["zz-health-1", { rows: 0, license: "etalab-2.0" }]]) })

		expect(auditTrainingManifest(empty)).toContain('source "zz-health-1" contributed 0 rows and should not be listed')
	})

	it("recomputes the same digest the freeze wrote", () => {
		const manifest = freeze()

		expect(trainingManifestDigest(manifest)).toBe(manifest.contentDigest)
	})
})

describe("sourcesNotPermitting", () => {
	it("names every source whose terms did not permit the operation, and says which of the reasons applies", () => {
		const blocking = sourcesNotPermitting(freeze(), SourceOperation.RedistributeModel)

		expect(blocking.map((entry) => entry.source)).toEqual(["zz-business-1", "zz-health-1"])
		expect(blocking[0]?.because).toContain("read unchecked when the corpus was built")
		expect(blocking[1]?.because).toContain("did not permit redistribute-model")
	})

	it("returns nothing when every source's elected grant permitted the operation", () => {
		expect(
			sourcesNotPermitting(
				freeze({ rowsBySource: new Map([["zz-health-1", { rows: 400, license: "etalab-2.0" }]]) }),
				SourceOperation.Train
			)
		).toEqual([])
	})

	it("says which gap stopped a source's decision from being found", () => {
		const blocking = sourcesNotPermitting(
			freeze({
				rowsBySource: new Map([
					["wof-admin", { rows: 30, license: "CC0-1.0" }],
					["zz-withdrawn-1", { rows: 20, license: "LicenseRef-withdrawn-terms-zz" }],
					["invented-zz", { rows: 10, license: "LicenseRef-authored" }],
				]),
			}),
			SourceOperation.Train
		)

		// The authored-only source is absent: no third party's terms reach its rows.
		// The build's rights admission reads it the same way.
		expect(blocking).toEqual([
			{ source: "wof-admin", because: "corpus-source-inputs.json did not map the source when the corpus was built" },
			{
				source: "zz-withdrawn-1",
				because: 'the register carried no decision for license "withdrawn-terms-zz" when the corpus was built',
			},
		])
	})

	it("says a record frozen before the lookup holds no reason for its missing decision", () => {
		const manifest = freeze({ rowsBySource: new Map([["wof-admin", { rows: 10, license: "CC0-1.0" }]]) })
		const { decisionGap: _, ...older } = manifest.sources[0]!

		const [blocking] = sourcesNotPermitting({ ...manifest, sources: [older] }, SourceOperation.Train)

		expect(blocking?.because).toContain("frozen before decisions were resolved through corpus-source-inputs.json")
	})
})
