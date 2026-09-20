/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	applyLicenseDecisions,
	auditAddressSourceRegister,
	electedLicenseLabel,
	ingestEligibilityProblems,
	JurisdictionResearchState,
	LicenseReviewState,
	readAddressSourceRegister,
	SourceStatus,
	UNRESOLVED_FIELDS,
	type AddressSourceRegister,
	type LicenseDecision,
} from "@mailwoman/corpus/source-register"
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

	it("passes its own audit", () => {
		expect(auditAddressSourceRegister(register)).toEqual([])
	})
})

describe("auditAddressSourceRegister", () => {
	const base: AddressSourceRegister = {
		registerID: "test",
		version: "0.0.0",
		provenance: { source: "test" },
		unresolved: ["addressRole", "upstreamLineage", "coverage"],
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
		// The register is generated and rewritten whole, so before this merge a decision recorded in the OUTPUT was
		// erased by the next build with no error. Each of these four fields is one the corpus acceptance rules require.
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
		// Such a decision licenses nothing. Applying it silently would leave the register asserting a grant no source
		// points at, which is the shape a typo or a removed source takes.
		expect(() =>
			applyLicenseDecisions(generated, new Map([["no-such-licence", { ...elected, licenseID: "no-such-licence" }]]))
		).toThrow(/does not carry/u)
	})

	/**
	 * The smallest register the audit accepts, so these cases read the audit's verdict on the applied decision rather
	 * than on the rest of the fixture.
	 */
	function registerWith(licenses: readonly LicenseDecision[]): AddressSourceRegister {
		return {
			registerID: "test",
			version: "0.0.0",
			provenance: { source: "test" },
			unresolved: ["addressRole", "upstreamLineage", "coverage"],
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
		// `buildSourceRegister` throws when the audit reports a problem, so an incomplete decision never reaches the
		// committed register. This is why the merge validates nothing itself.
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
