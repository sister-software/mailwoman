/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads and audits the address-source register.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { AssertedProposition } from "@mailwoman/evidence/status"
import type { PathBuilderLike } from "path-ts"

import {
	BackboneState,
	JurisdictionResearchState,
	LicenseReviewState,
	OperationPermission,
	PersonalDataReading,
	REGISTER_SECTORS,
	SourceGeometry,
	SourceOperation,
	SourceStatus,
	UNRESOLVED_FIELDS,
	type AddressSourceRecord,
	type AddressSourceRegister,
	type ElectedLicense,
	type LicenseDecision,
	type OperationDecision,
} from "#source-register/types"

/**
 * Resolves the path of the committed register through the package's `./data/*` export.
 *
 * Resolution happens on call so that importing this module works before the build has written the register.
 */
export function addressSourceRegisterPath(): string {
	return resolveModulePath("@mailwoman/corpus/data/address-source-register.json")
}

const PROPOSITIONS = new Set<string>(Object.values(AssertedProposition))
const SECTORS = new Set<string>(REGISTER_SECTORS)
const BACKBONE_STATES = new Set<string>(Object.values(BackboneState))
const RESEARCH_STATES = new Set<string>(Object.values(JurisdictionResearchState))
const SOURCE_STATUSES = new Set<string>(Object.values(SourceStatus))
const GEOMETRIES = new Set<string>(Object.values(SourceGeometry))
const PERSONAL_DATA_READINGS = new Set<string>(Object.values(PersonalDataReading))

/**
 * Returns the license label that the exclude filter in `@mailwoman/corpus/utils/license` matches by prefix.
 *
 * The function returns `undefined` until someone has elected terms for the decision.
 */
export function electedLicenseLabel(decision: LicenseDecision): string | undefined {
	if (decision.state !== LicenseReviewState.Elected) return undefined

	return decision.spdx ?? decision.electedTerms
}

/**
 * Replaces generated license decisions with recorded ones that share a license id.
 *
 * The build generates an `unchecked` decision for each license and rewrites the register
 * whole, so reviewed decisions live in a separate input and merge here.
 *
 * @throws When a recorded decision refers to a license that the generated set lacks.
 * Such a decision is a typo or refers to a removed source.
 */
export function applyLicenseDecisions(
	generated: readonly LicenseDecision[],
	recorded: ReadonlyMap<string, LicenseDecision>
): LicenseDecision[] {
	const known = new Set(generated.map((decision) => decision.licenseID))

	for (const licenseID of recorded.keys()) {
		if (!known.has(licenseID)) {
			throw new Error(
				`a recorded licence decision names ${stringifyJSON(licenseID)}, which the register does not carry. ` +
					"A decision that licenses nothing is a typo or a source that has been removed."
			)
		}
	}

	return generated.map((decision) => recorded.get(decision.licenseID) ?? decision)
}

/**
 * The operations that ingesting a source into the corpus performs.
 *
 * Redistribution and commercial sublicensing happen at release, so this list omits them.
 */
export const INGEST_OPERATIONS: readonly SourceOperation[] = [
	SourceOperation.Fetch,
	SourceOperation.Extract,
	SourceOperation.Transform,
	SourceOperation.Train,
]

/**
 * The operations that releasing a model trained on a source adds to {@link INGEST_OPERATIONS}.
 */
export const MODEL_RELEASE_OPERATIONS: readonly SourceOperation[] = [
	SourceOperation.RedistributeModel,
	SourceOperation.CommercialSublicense,
]

/**
 * Returns the recorded permission for one operation under a license decision.
 *
 * The result is `unreviewed` when the decision is not elected or does not mention the operation.
 * Electing terms establishes which terms apply, and each operation still needs its own review.
 */
export function permissionFor(decision: LicenseDecision, operation: SourceOperation): OperationDecision {
	if (decision.state !== LicenseReviewState.Elected) {
		return {
			permission: OperationPermission.Unreviewed,
			because: `the decision reads ${decision.state}, so no operation has been read against terms`,
		}
	}

	return (
		decision.operations?.[operation] ?? {
			permission: OperationPermission.Unreviewed,
			because: `the elected terms do not state whether ${operation} is permitted`,
		}
	)
}

/**
 * Returns every reason that a source may not enter a training corpus, or an empty array when it may.
 *
 * The function returns reasons so that callers can tell the different blockers apart.
 */
export function ingestEligibilityProblems(
	source: AddressSourceRecord,
	register: AddressSourceRegister,
	operations: readonly SourceOperation[] = INGEST_OPERATIONS
): readonly string[] {
	const problems: string[] = []
	const decision = register.licenses.find((entry) => entry.licenseID === source.license)

	if (!decision) {
		problems.push(`license ${stringifyJSON(source.license)} is not declared in the register`)
	} else if (decision.state !== LicenseReviewState.Elected) {
		problems.push(
			`license ${stringifyJSON(source.license)} is ${decision.state}, and only elected terms admit a source`
		)
	} else {
		for (const operation of operations) {
			const reading = permissionFor(decision, operation)

			if (reading.permission === OperationPermission.Permitted) continue

			problems.push(`the elected terms read ${reading.permission} for ${operation}: ${reading.because}`)
		}
	}

	if (source.status === SourceStatus.RetainedOriginal) {
		problems.push("the source was carried from the earlier memo and has not been re-resolved")
	}

	if (source.status === SourceStatus.VerifiedCorpusStale) {
		problems.push("the bulk copy that was examined has stopped being updated")
	}

	if (source.status === SourceStatus.VerifiedAuthority) {
		problems.push("the register was confirmed but its address fields and bulk access were not inspected")
	}

	if (!source.addressRole) {
		problems.push("no address role is resolved, so the grammar the rows carry is unknown")
	}

	if (!source.coverage) {
		problems.push("no coverage has been measured")
	}

	problems.push(...personalDataProblems(source))

	return problems
}

/**
 * Returns the personal-data problems that block ingest of a source.
 *
 * A missing review blocks ingest, because an unexamined publication has not been found clear.
 */
function personalDataProblems(source: AddressSourceRecord): string[] {
	const review = source.personalDataReview

	if (!review) {
		return ["no personal-data review is recorded, and an unexamined publication is not one found clear"]
	}

	if (review.reading === PersonalDataReading.Present) {
		return [`the publication carries records about identifiable people and no analysis is complete: ${review.because}`]
	}

	if (review.reading === PersonalDataReading.Assessed && !review.record) {
		return ["the personal-data review reads assessed and names no record, so the analysis cannot be read"]
	}

	return []
}

/**
 * Returns one message for each structural problem in a register.
 *
 * The content digest is checked separately on read, because the build audits registers
 * before it writes a digest.
 */
export function auditAddressSourceRegister(register: AddressSourceRegister): string[] {
	const problems: string[] = []

	if (!register.version) {
		problems.push("the register carries no version")
	}

	if (!register.jurisdictions.length) {
		problems.push("the jurisdiction table is empty")
	}

	problems.push(...auditLicenses(register))
	problems.push(...auditJurisdictions(register))
	problems.push(...auditSources(register))
	problems.push(...auditUnresolvedClaim(register))

	return problems
}

/**
 * Computes the SHA-256 digest of the register without its `contentDigest` field.
 *
 * The build and the read audit share this function so that they serialize identically.
 * The digest covers the parsed object, so reformatting the file keeps it valid.
 *
 * Key order is part of the serialization, so reordering keys by hand changes the digest.
 */
export function registerContentDigest(register: AddressSourceRegister): string {
	const { contentDigest: _omitted, ...rest } = register

	return sha256Hex(stringifyJSON(rest))
}

/**
 * Checks that a register read from disk still matches the digest that its build wrote.
 *
 * Only the read path runs this check, because the build and test fixtures
 * audit registers that have no digest.
 */
function auditContentDigest(register: AddressSourceRegister): string[] {
	if (!register.contentDigest) {
		return [
			"the register carries no `contentDigest`. It is written by `mailwoman corpus source-register`, and a register " +
				"without one cannot be told apart from a hand-edited copy.",
		]
	}

	const expected = registerContentDigest(register)

	if (expected === register.contentDigest) return []

	return [
		`the register's \`contentDigest\` reads ${register.contentDigest} and its content hashes to ${expected}. ` +
			"Something edited the file after the build wrote it. Regenerate it with the command in " +
			"`packages/corpus/data/PROVENANCE.md` rather than correcting the digest by hand.",
	]
}

function auditLicenses(register: AddressSourceRegister): string[] {
	const problems: string[] = []
	const seen = new Set<string>()
	const referenced = new Set(register.sources.map((source) => source.license))

	for (const decision of register.licenses) {
		const named = stringifyJSON(decision.licenseID)

		if (seen.has(decision.licenseID)) {
			problems.push(`license ${named} is declared twice`)
		}

		seen.add(decision.licenseID)

		if (!referenced.has(decision.licenseID)) {
			problems.push(`license ${named} is declared and no source points at it`)
		}

		switch (decision.state) {
			case LicenseReviewState.Unchecked: {
				if (!decision.publisherStatement) {
					problems.push(`license ${named} is unchecked and records no publisher statement`)
				}

				break
			}

			case LicenseReviewState.Elected: {
				problems.push(...auditElected(decision, named))

				break
			}

			case LicenseReviewState.Refused: {
				if (!decision.refusedBecause) {
					problems.push(`license ${named} is refused and gives no reason`)
				}

				break
			}

			default: {
				problems.push(`license ${named} carries an unknown review state`)
			}
		}
	}

	return problems
}

function auditElected(decision: ElectedLicense, named: string): string[] {
	const problems: string[] = []

	if (!decision.electedTerms) {
		problems.push(`license ${named} is elected and names no terms`)
	}

	if (!decision.retrievedCopy) {
		problems.push(`license ${named} is elected and names no retrieved copy`)
	}

	if (!decision.electedBecause) {
		problems.push(`license ${named} is elected and gives no reason`)
	}

	for (const [operation, reading] of Object.entries(decision.operations ?? {})) {
		if (!reading.because) {
			problems.push(`license ${named} reads ${reading.permission} for ${operation} and gives no reason`)
		}

		// A permission must cite its basis in the terms so that a reviewer can check it.
		// A refusal needs no basis.
		if (reading.permission === OperationPermission.Permitted && !reading.basis) {
			problems.push(`license ${named} permits ${operation} and names no basis for the permission`)
		}

		if (!(Object.values(OperationPermission) as string[]).includes(reading.permission)) {
			problems.push(
				`license ${named} reads an unknown permission ${stringifyJSON(reading.permission)} for ${operation}`
			)
		}

		if (!(Object.values(SourceOperation) as string[]).includes(operation)) {
			problems.push(
				`license ${named} names ${stringifyJSON(operation)}, which is not an operation this repository performs`
			)
		}
	}

	return problems
}

function auditJurisdictions(register: AddressSourceRegister): string[] {
	const problems: string[] = []
	const seen = new Set<string>()
	const sourceCounts = new Map<string, number>()

	for (const source of register.sources) {
		sourceCounts.set(source.iso2, (sourceCounts.get(source.iso2) ?? 0) + 1)
	}

	for (const jurisdiction of register.jurisdictions) {
		const named = stringifyJSON(jurisdiction.iso2)

		if (seen.has(jurisdiction.iso2)) {
			problems.push(`jurisdiction ${named} appears twice`)
		}

		seen.add(jurisdiction.iso2)

		if (!BACKBONE_STATES.has(jurisdiction.backboneState)) {
			problems.push(`jurisdiction ${named} carries an unknown backbone state`)
		}

		if (!RESEARCH_STATES.has(jurisdiction.researchState)) {
			problems.push(`jurisdiction ${named} carries an unknown research state`)
		}

		const count = sourceCounts.get(jurisdiction.iso2) ?? 0
		const seeded = jurisdiction.researchState === JurisdictionResearchState.Seeded

		if (seeded && count === 0) {
			problems.push(`jurisdiction ${named} is seeded and has no sources`)
		}

		if (!seeded && count > 0) {
			problems.push(`jurisdiction ${named} is ${jurisdiction.researchState} and has ${count} sources`)
		}

		if (!seeded && !jurisdiction.stateReason) {
			problems.push(`jurisdiction ${named} has no sources and does not say why`)
		}
	}

	return problems
}

function auditSources(register: AddressSourceRegister): string[] {
	const problems: string[] = []
	const known = new Set(register.jurisdictions.map((jurisdiction) => jurisdiction.iso2))
	const declared = new Set(register.licenses.map((decision) => decision.licenseID))
	const seen = new Set<string>()

	for (const source of register.sources) {
		const named = stringifyJSON(source.sourceID)

		if (seen.has(source.sourceID)) {
			problems.push(`source ${named} appears twice`)
		}

		seen.add(source.sourceID)

		if (!known.has(source.iso2)) {
			problems.push(
				`source ${named} names jurisdiction ${stringifyJSON(source.iso2)}, which the jurisdiction table does not carry`
			)
		}

		if (!SECTORS.has(source.sector)) {
			problems.push(`source ${named} names an unlisted sector`)
		}

		if (!SOURCE_STATUSES.has(source.status)) {
			problems.push(`source ${named} carries an unknown status`)
		}

		if (!GEOMETRIES.has(source.geometry)) {
			problems.push(`source ${named} carries an unknown geometry state`)
		}

		if (!declared.has(source.license)) {
			problems.push(`source ${named} points at an undeclared license decision`)
		}

		const review = source.personalDataReview

		if (review && !PERSONAL_DATA_READINGS.has(review.reading)) {
			problems.push(`source ${named} carries an unknown personal-data reading`)
		}

		if (review && !review.because) {
			problems.push(
				`source ${named} carries a personal-data review stating no reason, so nothing records what it rests on`
			)
		}

		if (review?.reading === PersonalDataReading.Assessed && !review.record) {
			problems.push(`source ${named} is assessed for personal data and names no record of the analysis`)
		}

		if (!source.asserts.length) {
			problems.push(`source ${named} asserts nothing`)
		}

		for (const proposition of source.asserts) {
			if (!PROPOSITIONS.has(proposition)) {
				problems.push(`source ${named} asserts ${stringifyJSON(proposition)}, which is not a proposition`)
			}
		}
	}

	return problems
}

function auditUnresolvedClaim(register: AddressSourceRegister): string[] {
	const problems: string[] = []
	const listed = new Set<string>(register.unresolved)

	for (const field of register.unresolved) {
		if (!UNRESOLVED_FIELDS.includes(field)) {
			problems.push(`${stringifyJSON(field)} is named unresolved and is not a field of a source`)
		}
	}

	for (const field of UNRESOLVED_FIELDS) {
		const resolved = register.sources.filter((source) => source[field] !== undefined)

		if (listed.has(field) && resolved.length) {
			problems.push(
				`${stringifyJSON(field)} is declared unresolved and ${resolved.length} sources carry it — ` +
					`drop it from \`unresolved\``
			)
		}

		if (!listed.has(field) && !resolved.length) {
			problems.push(`${stringifyJSON(field)} is not declared unresolved and no source carries it`)
		}
	}

	return problems
}

/**
 * Reads the committed register and checks its digest and structure.
 *
 * @throws When the file does not parse or the audit reports a problem.
 * The message lists every problem.
 */
export async function readAddressSourceRegister(path?: PathBuilderLike): Promise<AddressSourceRegister> {
	const resolved = path ?? addressSourceRegisterPath()
	const register = await readLocalJSONFile<AddressSourceRegister>(resolved)
	const problems = [...auditContentDigest(register), ...auditAddressSourceRegister(register)]

	if (problems.length) {
		throw new Error(`${resolved} failed the register audit:\n  ${problems.join("\n  ")}`)
	}

	return register
}
