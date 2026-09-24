/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import {
	applyLicenseDecisions,
	auditAddressSourceRegister,
	BackboneState,
	electedLicenseLabel,
	ingestEligibilityProblems,
	JurisdictionResearchState,
	LicenseReviewState,
	MODEL_RELEASE_OPERATIONS,
	OperationPermission,
	PermissionBasis,
	permissionFor,
	PersonalDataReading,
	readAddressSourceRegister,
	registerContentDigest,
	ResearchPass,
	SourceGeometry,
	SourceOperation,
	SourceStatus,
	UNRESOLVED_FIELDS,
	type AddressSourceRecord,
	type AddressSourceRegister,
	type ElectedLicense,
	type LicenseDecision,
} from "@mailwoman/corpus/source-register"
import { AddressRole } from "@mailwoman/corpus/types"
import { beforeAll, describe, expect, it } from "vitest"

describe("the committed address-source register", () => {
	let register: AddressSourceRegister

	beforeAll(async () => {
		register = await readAddressSourceRegister()
	})

	it("carries every jurisdiction, whether or not research found a source", () => {
		expect(register.jurisdictions).toHaveLength(250)
		expect(new Set(register.jurisdictions.map((row) => row.iso2)).size).toBe(250)
		expect(register.jurisdictions.some((row) => row.iso2 === "XK")).toBe(true)
	})

	it("states why a jurisdiction has no sources rather than leaving an empty list to speak for it", () => {
		const withSources = new Set(register.sources.map((row) => row.iso2))
		const without = register.jurisdictions.filter((row) => !withSources.has(row.iso2))

		expect(without).toHaveLength(10)

		for (const row of without) {
			expect(row.researchState).not.toBe(JurisdictionResearchState.Seeded)
			expect(row.stateReason).toBeTruthy()
		}

		// A researched absence and an unexamined one are different readings and stay different values.
		const states = without.map((row) => row.researchState)

		expect(states.filter((state) => state === JurisdictionResearchState.Exception)).toHaveLength(7)
		expect(states.filter((state) => state === JurisdictionResearchState.Unexamined)).toHaveLength(3)
	})

	it("carries the researched sources and none of the repeated discovery lookups", () => {
		expect(register.sources).toHaveLength(389)
		expect(new Set(register.sources.map((row) => row.sourceID)).size).toBe(389)

		const byStatus = (status: SourceStatus): number => register.sources.filter((row) => row.status === status).length

		expect(byStatus(SourceStatus.VerifiedAuthority)).toBe(221)
		expect(byStatus(SourceStatus.RetainedOriginal)).toBe(142)
		expect(byStatus(SourceStatus.VerifiedCorpus)).toBe(25)
		expect(byStatus(SourceStatus.VerifiedCorpusStale)).toBe(1)
	})

	it("declares the fields no source resolved, and no source resolves one", () => {
		expect([...register.unresolved].toSorted()).toEqual([...UNRESOLVED_FIELDS].toSorted())

		for (const field of register.unresolved) {
			expect(register.sources.filter((row) => row[field] !== undefined)).toHaveLength(0)
		}
	})

	it("holds no source eligible for ingest, because no licence has been reviewed", () => {
		expect(register.licenses.every((decision) => decision.state === LicenseReviewState.Unchecked)).toBe(true)

		for (const source of register.sources) {
			expect(ingestEligibilityProblems(source, register).length).toBeGreaterThan(0)
		}
	})

	it("gives every source its own license decision, so one reading cannot grant many", () => {
		// The register was built with one shared `unchecked-national-terms` id over 247 of the 389 sources.
		// Electing terms against that id would have granted all 247 on one reading of one publisher's page.
		// Each source now points at a decision of its own, which is what makes an
		// election a statement about one publication.
		const bySource = new Map<string, string[]>()

		for (const source of register.sources) {
			bySource.set(source.license, [...(bySource.get(source.license) ?? []), source.sourceID])
		}

		expect(bySource.size).toBe(register.sources.length)
		expect([...bySource.values()].filter((sources) => sources.length > 1)).toEqual([])
	})

	it("passes its own audit", () => {
		expect(auditAddressSourceRegister(register)).toEqual([])
	})

	it("still hashes to the digest its build wrote", () => {
		expect(register.contentDigest).toBe(registerContentDigest(register))
	})

	it("refuses a copy whose publisher name was edited after the build", async () => {
		// The worked case: a prose sweep rewrote `Contracts Finder / Find a Tender` to
		// `Interfaces Finder / Find a Tender` on three rows, and the structural audit passed
		// because it checks shape rather than whether a name is the publisher's (#2352).
		// One character is enough to move the digest.
		await using scratch = await temporaryDirectory("mw-register-edited-")
		const edited = { ...register, sources: register.sources.map((source) => ({ ...source })) }
		const path = scratch.resolve("address-source-register.json")

		edited.sources[0] = { ...edited.sources[0]!, publisher: `${edited.sources[0]!.publisher} ` }

		await writeLocalJSONFile(edited, path)

		await expect(readAddressSourceRegister(path)).rejects.toThrow(/Something edited the file/u)
	})
})

describe("auditAddressSourceRegister", () => {
	const base: AddressSourceRegister = {
		registerID: "test",
		version: "0.0.0",
		// A literal nobody generated, so it carries no meaningful digest.
		// The structural audit does not read the field — `readAddressSourceRegister`
		// checks it, against a file a build wrote.
		contentDigest: "",
		provenance: { source: "test" },
		unresolved: ["addressRole", "upstreamLineage", "coverage", "personalDataReview"],
		licenses: [
			{
				licenseID: "unchecked-test",
				state: LicenseReviewState.Unchecked,
				publisherStatement: "CHECK TERMS",
				note: "nobody opened them",
			},
		],
		jurisdictions: [
			{
				iso2: "ZZ",
				name: "Testland",
				backboneState: "C",
				researchState: JurisdictionResearchState.Seeded,
				bestPath: "G0",
				assertionPlan: "IDENTITY + OBSERVATION",
				note: "a fixture",
			},
		],
		sources: [
			{
				sourceID: "zz-health-1",
				iso2: "ZZ",
				sector: "health",
				name: "Testland facility register",
				status: SourceStatus.VerifiedAuthority,
				asserts: ["identity", "observation"],
				authorityBasis: "national health ministry",
				geometry: "unresolved",
				license: "unchecked-test",
				researchPass: "2026-09-18-web-research",
			},
		],
	}

	it("accepts a well-formed register", () => {
		expect(auditAddressSourceRegister(base)).toEqual([])
	})

	it("refuses a seeded jurisdiction with no sources", () => {
		const problems = auditAddressSourceRegister({ ...base, sources: [] })

		expect(problems).toContain('jurisdiction "ZZ" is seeded and has no sources')
	})

	it("refuses a jurisdiction that has no sources and does not say why", () => {
		const problems = auditAddressSourceRegister({
			...base,
			jurisdictions: [{ ...base.jurisdictions[0]!, researchState: JurisdictionResearchState.Unexamined }],
			sources: [],
		})

		expect(problems).toContain('jurisdiction "ZZ" has no sources and does not say why')
	})

	it("refuses a source naming a jurisdiction the register does not carry", () => {
		const problems = auditAddressSourceRegister({
			...base,
			sources: [{ ...base.sources[0]!, iso2: "QQ" }],
		})

		expect(problems).toContain(
			'source "zz-health-1" names jurisdiction "QQ", which the jurisdiction table does not carry'
		)
	})

	it("refuses a source pointing at a licence decision nothing declares", () => {
		const problems = auditAddressSourceRegister({
			...base,
			sources: [{ ...base.sources[0]!, license: "no-such-decision" }],
		})

		expect(problems).toContain('source "zz-health-1" points at an undeclared license decision')
	})

	it("refuses an elected licence with no retrieved copy", () => {
		const problems = auditAddressSourceRegister({
			...base,
			licenses: [
				{
					licenseID: "unchecked-test",
					state: LicenseReviewState.Elected,
					electedTerms: "Licence Ouverte 2.0",
					retrievedCopy: "",
					electedBecause: "attribution only",
				},
			],
		})

		expect(problems).toContain('license "unchecked-test" is elected and names no retrieved copy')
	})

	it("refuses a field declared unresolved that a source resolves", () => {
		const problems = auditAddressSourceRegister({
			...base,
			sources: [{ ...base.sources[0]!, coverage: "measured nationally" }],
		})

		expect(problems.some((problem) => problem.startsWith('"coverage" is declared unresolved'))).toBe(true)
	})
})

describe("electedLicenseLabel", () => {
	it("answers nothing for an unchecked decision, so an unread source cannot pass a licence filter", () => {
		expect(
			electedLicenseLabel({
				licenseID: "unchecked-access-free",
				state: LicenseReviewState.Unchecked,
				publisherStatement: "Free",
				note: "an access label",
			})
		).toBeUndefined()
	})

	it("prefers the SPDX identifier over the publisher's wording", () => {
		expect(
			electedLicenseLabel({
				licenseID: "ban-licence-ouverte",
				state: LicenseReviewState.Elected,
				electedTerms: "Licence Ouverte 2.0",
				spdx: "etalab-2.0",
				retrievedCopy: "data/licenses/ban-licence-ouverte-2.0.txt",
				electedBecause: "attribution only; the ODbL option's share-alike defeats a proprietary-weights build",
			})
		).toBe("etalab-2.0")
	})
})

describe("applyLicenseDecisions", () => {
	const generated: readonly LicenseDecision[] = [
		{
			licenseID: "unchecked-national-terms",
			state: LicenseReviewState.Unchecked,
			publisherStatement: "CHECK NATIONAL / DATASET TERMS",
			note: "the research pass did not open them",
		},
		{
			licenseID: "unchecked-access-free",
			state: LicenseReviewState.Unchecked,
			publisherStatement: "Free",
			note: "an access label",
		},
	]

	const elected: LicenseDecision = {
		licenseID: "unchecked-national-terms",
		state: LicenseReviewState.Elected,
		electedTerms: "Licence Ouverte 2.0",
		spdx: "etalab-2.0",
		retrievedCopy: "data/licenses/ban-licence-ouverte-2.0.txt",
		electedBecause: "attribution only, and the dual grant's other half carries share-alike",
	}

	it("replaces a generated decision and leaves every other one alone", () => {
		const applied = applyLicenseDecisions(generated, new Map([[elected.licenseID, elected]]))

		expect(applied).toHaveLength(generated.length)
		expect(applied[0]).toEqual(elected)
		expect(applied[1]).toEqual(generated[1])
	})

	it("preserves every field of the recorded decision, which is what a rebuild used to lose", () => {
		// The register is generated and rewritten whole, so before this merge a decision
		// recorded in the OUTPUT was erased by the next build with no error.
		// Each of these four fields is one the corpus acceptance rules require.
		const applied = applyLicenseDecisions(generated, new Map([[elected.licenseID, elected]]))
		const survivor = applied[0] as typeof elected

		expect(survivor.electedTerms).toBe("Licence Ouverte 2.0")
		expect(survivor.spdx).toBe("etalab-2.0")
		expect(survivor.retrievedCopy).toBe("data/licenses/ban-licence-ouverte-2.0.txt")
		expect(survivor.electedBecause).toContain("attribution only")
	})

	it("carries a refusal through as readily as an election", () => {
		const refused: LicenseDecision = {
			licenseID: "unchecked-access-free",
			state: LicenseReviewState.Refused,
			refusedBecause: "the terms forbid redistribution of a derived dataset",
		}

		const applied = applyLicenseDecisions(generated, new Map([[refused.licenseID, refused]]))

		expect(applied[1]).toEqual(refused)
	})

	it("returns the generated decisions unchanged when nothing is recorded", () => {
		expect(applyLicenseDecisions(generated, new Map())).toEqual(generated)
	})

	it("refuses a decision naming a licence the register does not carry", () => {
		// Such a decision licenses nothing.
		// Applying it silently would leave the register asserting a grant no source points at,
		// which is the shape a typo or a removed source takes.
		expect(() =>
			applyLicenseDecisions(generated, new Map([["no-such-licence", { ...elected, licenseID: "no-such-licence" }]]))
		).toThrow(/does not carry/u)
	})

	/**
	 * The smallest register the audit accepts, so these cases read the audit's verdict
	 * on the applied decision rather than on the rest of the fixture.
	 */
	function registerWith(licenses: readonly LicenseDecision[]): AddressSourceRegister {
		return {
			registerID: "test",
			version: "0.0.0",
			contentDigest: "",
			provenance: { source: "test" },
			unresolved: ["addressRole", "upstreamLineage", "coverage", "personalDataReview"],
			licenses,
			jurisdictions: [
				{
					iso2: "ZZ",
					name: "Testland",
					backboneState: "C",
					researchState: JurisdictionResearchState.Seeded,
					bestPath: "G0",
					assertionPlan: "IDENTITY + OBSERVATION",
					note: "a fixture",
				},
			],
			sources: [
				{
					sourceID: "zz-health-1",
					iso2: "ZZ",
					sector: "health",
					name: "Testland facility register",
					status: SourceStatus.VerifiedAuthority,
					asserts: ["identity", "observation"],
					authorityBasis: "national health ministry",
					geometry: "unresolved",
					license: "unchecked-national-terms",
					researchPass: "2026-09-18-web-research",
				},
			],
		}
	}

	it("keeps the applied register passing its own audit", () => {
		const applied = applyLicenseDecisions([generated[0] as LicenseDecision], new Map([[elected.licenseID, elected]]))

		expect(auditAddressSourceRegister(registerWith(applied))).toEqual([])
	})

	it("fails the audit when the recorded decision is incomplete, so the build refuses it", () => {
		// `buildSourceRegister` throws when the audit reports a problem, so an incomplete
		// decision never reaches the committed register.
		// This is why the merge validates nothing itself.
		const incomplete = {
			licenseID: "unchecked-national-terms",
			state: LicenseReviewState.Elected,
		} as LicenseDecision

		const applied = applyLicenseDecisions(
			[generated[0] as LicenseDecision],
			new Map([["unchecked-national-terms", incomplete]])
		)

		expect(auditAddressSourceRegister(registerWith(applied))).toEqual([
			'license "unchecked-national-terms" is elected and names no terms',
			'license "unchecked-national-terms" is elected and names no retrieved copy',
			'license "unchecked-national-terms" is elected and gives no reason',
		])
	})
})

describe("permission by operation", () => {
	const source: AddressSourceRecord = {
		sourceID: "zz-health-1",
		iso2: "ZZ",
		sector: "health",
		name: "Testland facility register",
		status: SourceStatus.VerifiedCorpus,
		asserts: ["identity", "observation"],
		authorityBasis: "national health ministry",
		geometry: SourceGeometry.Unresolved,
		license: "terms-under-review",
		researchPass: ResearchPass.WebResearch,
		addressRole: AddressRole.Premise,
		coverage: "measured national, 2026-09",
		personalDataReview: {
			reading: PersonalDataReading.Absent,
			because: "every row names a licensed facility rather than a person",
		},
	}

	function registerWith(decision: LicenseDecision): AddressSourceRegister {
		return {
			registerID: "test",
			version: "0.0.0",
			contentDigest: "",
			provenance: { source: "test" },
			unresolved: ["addressRole", "upstreamLineage", "coverage"],
			licenses: [decision],
			jurisdictions: [
				{
					iso2: "ZZ",
					name: "Testland",
					backboneState: BackboneState.Unverified,
					researchState: JurisdictionResearchState.Seeded,
					bestPath: "G0",
					assertionPlan: "IDENTITY + OBSERVATION",
					note: "a fixture",
				},
			],
			sources: [source],
		}
	}

	const permits = (because: string) => ({
		permission: OperationPermission.Permitted,
		basis: PermissionBasis.PublisherGrant,
		because,
	})

	/**
	 * A grant permitting every act ingest performs and silent on publishing a model trained on it.
	 *
	 * That is the ordinary shape of a national open-data license, which addresses reuse of
	 * the data rather than redistribution of a statistical model derived from it.
	 */
	const ingestOnly: ElectedLicense = {
		licenseID: "terms-under-review",
		state: LicenseReviewState.Elected,
		electedTerms: "Testland Open Data Licence 1.0",
		retrievedCopy: "data/licenses/testland-1.0.txt",
		electedBecause: "the only grant the publisher offers",
		operations: {
			[SourceOperation.Fetch]: permits("§2 permits copying the published file"),
			[SourceOperation.Extract]: permits("§2 permits copying the published file"),
			[SourceOperation.Transform]: permits("§3 permits adaptation"),
			[SourceOperation.Train]: permits("§3 permits adaptation"),
		},
	}

	it("admits a source for ingest when the terms permit every act ingest performs", () => {
		expect(ingestEligibilityProblems(source, registerWith(ingestOnly))).toEqual([])
	})

	it("refuses model release on that same grant, because the terms never mention it", () => {
		// A permissive dataset may be used without becoming publication-cleared.
		// The grant is unchanged and the act being asked about is different.
		const problems = ingestEligibilityProblems(source, registerWith(ingestOnly), MODEL_RELEASE_OPERATIONS)

		expect(problems).toHaveLength(2)
		expect(problems[0]).toContain("unreviewed for redistribute-model")
		expect(problems[1]).toContain("unreviewed for commercial-sublicense")
	})

	it("reads an operation the elected terms omit as unreviewed rather than permitted", () => {
		const reading = permissionFor(ingestOnly, SourceOperation.RedistributeModel)

		expect(reading.permission).toBe(OperationPermission.Unreviewed)
		expect(reading.because).toContain("do not state whether redistribute-model is permitted")
	})

	it("reads every operation as unreviewed while the decision is unchecked", () => {
		const unchecked: LicenseDecision = {
			licenseID: "terms-under-review",
			state: LicenseReviewState.Unchecked,
			publisherStatement: "Free",
			note: "an access label",
		}

		for (const operation of Object.values(SourceOperation)) {
			expect(permissionFor(unchecked, operation).permission).toBe(OperationPermission.Unreviewed)
		}
	})

	it("blocks the refused act alone and quotes the reviewer's reason", () => {
		const refusesCommercial: ElectedLicense = {
			...ingestOnly,
			operations: {
				...ingestOnly.operations,
				[SourceOperation.RedistributeModel]: permits("§5 permits redistribution of derived works"),
				[SourceOperation.CommercialSublicense]: {
					permission: OperationPermission.Refused,
					because: "§6 restricts reuse to non-commercial purposes",
				},
			},
		}

		expect(ingestEligibilityProblems(source, registerWith(refusesCommercial))).toEqual([])

		expect(ingestEligibilityProblems(source, registerWith(refusesCommercial), MODEL_RELEASE_OPERATIONS)).toEqual([
			"the elected terms read refused for commercial-sublicense: §6 restricts reuse to non-commercial purposes",
		])
	})

	/**
	 * A license grant answers whether the publisher permits an act.
	 *
	 * Whether the records are about identifiable people is governed by different law
	 * and reached through a different analysis, so an elected grant must not admit
	 * a source whose personal-data question nobody asked.
	 */
	describe("personal data", () => {
		const { personalDataReview: _reviewed, ...unreviewed } = source

		it("refuses a source nobody reviewed, even on terms that permit every act ingest performs", () => {
			expect(ingestEligibilityProblems(unreviewed, registerWith(ingestOnly))).toEqual([
				"no personal-data review is recorded, and an unexamined publication is not one found clear",
			])
		})

		it("refuses a publication found to carry records about identifiable people, and quotes the finding", () => {
			const soleTraders: AddressSourceRecord = {
				...source,
				personalDataReview: {
					reading: PersonalDataReading.Present,
					because: "the register publishes entrepreneurs individuels, whose business address is a home address",
				},
			}

			expect(ingestEligibilityProblems(soleTraders, registerWith(ingestOnly))).toEqual([
				"the publication carries records about identifiable people and no analysis is complete: the register publishes entrepreneurs individuels, whose business address is a home address",
			])
		})

		it("admits a publication whose analysis is complete and recorded", () => {
			const assessed: AddressSourceRecord = {
				...source,
				personalDataReview: {
					reading: PersonalDataReading.Assessed,
					because: "sole-trader rows are excluded at extract and the remainder name legal entities",
					record: "docs/records/privacy/testland-health-2026-09.md",
				},
			}

			expect(ingestEligibilityProblems(assessed, registerWith(ingestOnly))).toEqual([])
		})

		it("refuses an assessment that names no record, so nobody can read the analysis", () => {
			const unrecorded: AddressSourceRecord = {
				...source,
				personalDataReview: {
					reading: PersonalDataReading.Assessed,
					because: "somebody looked",
				},
			}

			expect(ingestEligibilityProblems(unrecorded, registerWith(ingestOnly))).toEqual([
				"the personal-data review reads assessed and names no record, so the analysis cannot be read",
			])

			expect(auditAddressSourceRegister({ ...registerWith(ingestOnly), sources: [unrecorded] })).toContain(
				'source "zz-health-1" is assessed for personal data and names no record of the analysis'
			)
		})
	})

	/**
	 * The grant shapes counsel is reading, written as the per-operation record would hold them.
	 *
	 * These are fixtures rather than elections.
	 * No decision is recorded for any source, and nothing here elects one.
	 *
	 * What they establish is that the model can express each shape a real national
	 * grant takes, and that the shape decides which acts it admits rather than a
	 * single permissive or restrictive label doing so.
	 */
	describe("real grant shapes", () => {
		const everyIngestAct = {
			[SourceOperation.Fetch]: permits("the grant permits copying the published file"),
			[SourceOperation.Extract]: permits("the grant permits copying the published file"),
			[SourceOperation.Transform]: permits("the grant permits adaptation"),
			[SourceOperation.Train]: permits("the grant permits adaptation"),
		}

		it("admits every act under an attribution-only grant that names commercial reuse", () => {
			// Licence Ouverte 2.0's shape: reuse for commercial or non-commercial purposes, worldwide,
			// with one condition, and no reciprocal licensing requirement for a derivative work.
			const attributionOnly: ElectedLicense = {
				licenseID: "terms-under-review",
				state: LicenseReviewState.Elected,
				electedTerms: "Licence Ouverte / Open Licence 2.0",
				retrievedCopy: "data/licenses/licence-ouverte-2.0.md",
				electedBecause: "the grant the publisher's dataset page names",
				operations: {
					...everyIngestAct,
					[SourceOperation.RedistributeData]: permits("the grant permits diffuser, redistribuer et publier"),
					[SourceOperation.RedistributeModel]: permits("the grant permits redistribution of an adapted work"),
					[SourceOperation.CommercialSublicense]: permits("the grant names exploiter à titre commercial"),
				},
			}

			expect(ingestEligibilityProblems(source, registerWith(attributionOnly))).toEqual([])
			expect(ingestEligibilityProblems(source, registerWith(attributionOnly), MODEL_RELEASE_OPERATIONS)).toEqual([])
		})

		it("admits a grant whose permission carries a condition, with the condition recorded beside it", () => {
			// A modification-notice grant permits the act and requires a statement that the work was changed.
			// The condition lives in `because` rather than becoming a refusal, because the act is permitted.
			const modificationNotice: ElectedLicense = {
				licenseID: "terms-under-review",
				state: LicenseReviewState.Elected,
				electedTerms: "Norwegian Licence for Open Government Data 2.0",
				retrievedCopy: "data/licenses/nlod-2.0.md",
				electedBecause: "the grant the publisher names on the dataset page",
				operations: {
					...everyIngestAct,
					[SourceOperation.RedistributeModel]: permits(
						"the grant permits redistribution and requires a statement that the data was modified"
					),
				},
			}

			expect(ingestEligibilityProblems(source, registerWith(modificationNotice))).toEqual([])

			expect(permissionFor(modificationNotice, SourceOperation.RedistributeModel).because).toContain(
				"requires a statement that the data was modified"
			)
		})

		it("refuses model redistribution under a share-alike grant while admitting ingest", () => {
			// The ODbL half of a dual-licensed dataset.
			// Ingest is permitted and publishing a model trained on it is the act the reciprocal
			// condition reaches, so the two answers differ under one grant.
			const shareAlike: ElectedLicense = {
				licenseID: "terms-under-review",
				state: LicenseReviewState.Elected,
				electedTerms: "ODbL 1.0",
				retrievedCopy: "data/licenses/odbl-1.0.md",
				electedBecause: "the reciprocal half of the publisher's dual grant",
				operations: {
					...everyIngestAct,
					[SourceOperation.RedistributeModel]: {
						permission: OperationPermission.Refused,
						because: "§4.4 requires a derived database to be offered under these same terms",
					},
				},
			}

			expect(ingestEligibilityProblems(source, registerWith(shareAlike))).toEqual([])

			expect(ingestEligibilityProblems(source, registerWith(shareAlike), MODEL_RELEASE_OPERATIONS)).toEqual([
				"the elected terms read refused for redistribute-model: §4.4 requires a derived database to be offered under these same terms",
				"the elected terms read unreviewed for commercial-sublicense: the elected terms do not state whether commercial-sublicense is permitted",
			])
		})

		it("records which half of a dual grant was elected, so the other half's conditions are not inherited", () => {
			// A dual-licensed publication offers a choice.
			// Electing one half is a decision with a reason, and the decision's own fields carry
			// which half and why rather than a reader inferring it from the operations.
			const elected: ElectedLicense = {
				licenseID: "terms-under-review",
				state: LicenseReviewState.Elected,
				electedTerms: "Licence Ouverte / Open Licence 2.0",
				retrievedCopy: "data/licenses/licence-ouverte-2.0.md",
				electedBecause: "the attribution-only half of the publisher's Licence Ouverte or ODbL choice",
				operations: everyIngestAct,
			}

			expect(electedLicenseLabel(elected)).toBe("Licence Ouverte / Open Licence 2.0")
			expect(elected.electedBecause).toContain("attribution-only half")

			// Electing the permissive half says nothing about publishing a model,
			// which nobody read these terms against.
			// It reads unreviewed rather than inheriting either half's answer.
			expect(permissionFor(elected, SourceOperation.RedistributeModel).permission).toBe(OperationPermission.Unreviewed)
		})
	})

	it("fails the audit when a permission names no basis", () => {
		const unsupported: ElectedLicense = {
			...ingestOnly,
			operations: {
				[SourceOperation.Train]: { permission: OperationPermission.Permitted, because: "it seems fine" },
			},
		}

		expect(auditAddressSourceRegister(registerWith(unsupported))).toContain(
			'license "terms-under-review" permits train and names no basis for the permission'
		)
	})
})
