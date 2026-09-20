/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The frozen source record, and the two things that make it worth having.
 *
 *   It has to be reproducible, so two builds over identical inputs agree and a reader can compare them. And it has to
 *   be sensitive, so a source, a grant, a row count or a recipe moving changes the digest rather than passing as the
 *   same record. A manifest that satisfied one and not the other would be either unusable or a rubber stamp.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import {
	auditTrainingManifest,
	freezeTrainingManifest,
	LicenseReviewState,
	OperationPermission,
	PermissionBasis,
	SourceOperation,
	sourcesNotPermitting,
	trainingManifestDigest,
	type LicenseDecision,
} from "@mailwoman/corpus/source-register"
import { describe, expect, it } from "vitest"

const elected: LicenseDecision = {
	licenseID: "testland-open-data",
	state: LicenseReviewState.Elected,
	electedTerms: "Testland Open Data Licence 1.0",
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

const unchecked: LicenseDecision = {
	licenseID: "unchecked-national-terms-zz-ministry",
	state: LicenseReviewState.Unchecked,
	publisherStatement: "CHECK NATIONAL / DATASET TERMS",
	note: "nobody opened the terms",
}

function freeze(overrides: Partial<Parameters<typeof freezeTrainingManifest>[0]> = {}) {
	return freezeTrainingManifest({
		corpusVersion: "0.1.0",
		builtAt: "2026-09-20T12:00:00.000Z",
		profile: "release-eligible",
		rowsBySource: new Map([
			["zz-health-1", { rows: 400, license: "testland-open-data" }],
			["zz-business-1", { rows: 900, license: "unchecked-national-terms-zz-ministry" }],
		]),
		decisionsByLicense: new Map([
			[elected.licenseID, elected],
			[unchecked.licenseID, unchecked],
		]),
		refused: new Map([["zz-transport-1", ["no coverage has been measured"]]]),
		...overrides,
	})
}

describe("freezeTrainingManifest", () => {
	it("produces a byte-identical manifest from identical inputs", () => {
		expect(stringifyJSON(freeze())).toBe(stringifyJSON(freeze()))
	})

	it("orders sources by rows so the largest contributor reads first", () => {
		expect(freeze().sources.map((record) => record.source)).toEqual(["zz-business-1", "zz-health-1"])
		expect(freeze().totalRows).toBe(1300)
	})

	it("records which operations the elected grant permitted, and records none for an unchecked one", () => {
		const [business, health] = freeze().sources

		expect(health?.decision?.state).toBe(LicenseReviewState.Elected)
		expect(health?.decision?.permitted).toEqual([SourceOperation.Fetch, SourceOperation.Train])
		expect(business?.decision?.state).toBe(LicenseReviewState.Unchecked)
		expect(business?.decision?.permitted).toEqual([])
	})

	it("records a null decision for a license the register never carried", () => {
		// An adapter stamping its own label — `CC0-1.0`, `Public Domain` — matches no register decision. A null says
		// that, where omitting the source would make the build look as though it never read one.
		const manifest = freeze({
			rowsBySource: new Map([["wof-admin", { rows: 10, license: "CC0-1.0" }]]),
		})

		expect(manifest.sources[0]?.decision).toBeNull()
		expect(manifest.sources[0]?.license).toBe("CC0-1.0")
	})

	for (const [what, overrides] of [
		[
			"a source's row count",
			{ rowsBySource: new Map([["zz-health-1", { rows: 401, license: "testland-open-data" }]]) },
		],
		["the corpus version", { corpusVersion: "0.2.0" }],
		["the build profile", { profile: "exploratory" }],
		["a refused source's reasons", { refused: new Map([["zz-transport-1", ["no address role is resolved"]]]) }],
		[
			"an elected grant's permitted operations",
			{
				decisionsByLicense: new Map([
					[elected.licenseID, { ...elected, operations: {} } as LicenseDecision],
					[unchecked.licenseID, unchecked],
				]),
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
		// The digest is what makes this record frozen rather than merely written. A hand edit to a generated artifact is
		// the failure the source register's own digest exists to catch (#2352), and it applies here for the same reason.
		const edited = freeze()

		edited.sources[0]!.rows = 1

		expect(auditTrainingManifest(edited)).toContain(
			"the manifest's content digest does not match its contents, so something edited it after its build"
		)
	})

	it("refuses a source listed with no rows", () => {
		const empty = freeze({ rowsBySource: new Map([["zz-health-1", { rows: 0, license: "testland-open-data" }]]) })

		expect(auditTrainingManifest(empty)).toContain('source "zz-health-1" contributed 0 rows and should not be listed')
	})

	it("recomputes the same digest the freeze wrote", () => {
		const manifest = freeze()

		expect(trainingManifestDigest(manifest)).toBe(manifest.contentDigest)
	})
})

describe("sourcesNotPermitting", () => {
	it("names every source whose terms did not permit the operation, and says which of the three reasons applies", () => {
		const blocking = sourcesNotPermitting(freeze(), SourceOperation.RedistributeModel)

		expect(blocking.map((entry) => entry.source)).toEqual(["zz-business-1", "zz-health-1"])
		expect(blocking[0]?.because).toContain("read unchecked when the corpus was built")
		expect(blocking[1]?.because).toContain("did not permit redistribute-model")
	})

	it("returns nothing when every source's elected grant permitted the operation", () => {
		expect(
			sourcesNotPermitting(
				freeze({ rowsBySource: new Map([["zz-health-1", { rows: 400, license: "testland-open-data" }]]) }),
				SourceOperation.Train
			)
		).toEqual([])
	})

	it("names a source whose license the register never carried", () => {
		const blocking = sourcesNotPermitting(
			freeze({ rowsBySource: new Map([["wof-admin", { rows: 10, license: "CC0-1.0" }]]) }),
			SourceOperation.Train
		)

		expect(blocking[0]?.because).toContain("carried no decision for license")
	})
})
