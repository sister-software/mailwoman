/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reader and audit for the address-source register.
 *
 *   {@linkcode readAddressSourceRegister} refuses a register that fails {@linkcode auditAddressSourceRegister}, the
 *   same interface `@mailwoman/activity-lexicon` uses: a table nobody can check is a claim, and a consumer that
 *   silently accepted a broken one would report a missing source as an absent source.
 *
 *   Nothing here ranks, scores or orders. The register reports what is known about a source and what remains
 *   unresolved. Which source to reach for is a decision the caller makes with the eligibility reasons in front of it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { AssertedProposition } from "@mailwoman/evidence/status"

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
 * The committed register, resolved through the package manifest's own `./data/*` export.
 *
 * A function rather than a module-level constant: resolving at import time makes the register's absence
 * an error in every consumer of this package, including the build that writes it in the first place.
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
 * The label the mechanical exclude filter in `@mailwoman/corpus/utils/license` reads
 * for a decision, or `undefined` when no terms have been elected.
 *
 * The filter keeps working on a string prefix, as it always has.
 * What changed is which string it reads: the elected terms, so a source labelled `Free` reaches
 * the filter only once somebody has opened the publisher's terms and recorded what they grant.
 */
export function electedLicenseLabel(decision: LicenseDecision): string | undefined {
	if (decision.state !== LicenseReviewState.Elected) return undefined

	return decision.spdx ?? decision.electedTerms
}

/**
 * The generated decisions with any recorded decision applied over them.
 *
 * The register's build derives one `unchecked` decision per access label the research pass recorded,
 * which is the honest default: that pass wrote down what a register costs to reach and opened
 * nobody's terms. A decision somebody made by reading those terms replaces the default here.
 *
 * It is a merge rather than an edit of the built register because the register is generated
 * and rewritten whole. A decision recorded in the output would be erased by the next
 * rebuild, with no error and a normal-looking count (#2351).
 *
 * @throws When a recorded decision names a licence the generated set does not carry.
 *   That decision licenses nothing — either a typo or a source that has been removed —
 *   and applying it silently would leave the register asserting a grant no source points at.
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
 * Every reason a source may not enter a training corpus, or an empty array when it may.
 *
 * It answers with the reasons rather than a boolean because "not eligible" is four different
 * situations and a caller told only `false` would have to guess which one it met.
 */
/**
 * The operations bringing a source into the corpus performs.
 *
 * Redistributing the rows or the weights, and selling a commercial license over
 * either, are separate acts that happen at publish time rather than at ingest.
 * Asking for them here would refuse a source for an act this build does not perform,
 * and a control that refuses the wrong act teaches a reader to route around it.
 */
export const INGEST_OPERATIONS: readonly SourceOperation[] = [
	SourceOperation.Fetch,
	SourceOperation.Extract,
	SourceOperation.Transform,
	SourceOperation.Train,
]

/**
 * The operations publishing a model trained on a source performs, over and above ingest.
 */
export const MODEL_RELEASE_OPERATIONS: readonly SourceOperation[] = [
	SourceOperation.RedistributeModel,
	SourceOperation.CommercialSublicense,
]

/**
 * What an elected grant says about one operation, with `unreviewed` for an operation it does not name.
 *
 * The default is the whole point. An elected grant establishes which terms apply rather than that
 * every act under them is allowed, so an unnamed operation is one nobody read the terms against.
 * Returning `permitted` for it would turn the act of electing terms into a blanket permission,
 * which is the reading the per-operation record exists to refuse.
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
 * What a source's personal-data review leaves in the way of ingest.
 *
 * A license grant and a personal-data reading are separate questions, so an elected
 * grant never answers this one. The absence of a review refuses rather than admits,
 * which is the property the whole register is built on: nobody having looked is a
 * different answer from somebody having looked and found nothing.
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
 * Everything wrong with a register that can be established without leaving
 * this package, one message per problem.
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
 * The sha256 the register's `contentDigest` field must carry, over everything else in it.
 *
 * Exported because the build writes what the audit checks, and two implementations
 * of one serialization would drift into a digest that never matches.
 *
 * The digest covers the register as parsed rather than as bytes.
 * `prettyJSON` writes it and `oxfmt` reformats the file afterwards, so a byte digest
 * would name the formatter's output and break whenever the formatter changed.
 * `JSON.parse` preserves key insertion order, so re-serializing a parsed register reproduces the order
 * the build wrote — which means a hand edit that reorders keys also fails, and that is a hand edit.
 */
export function registerContentDigest(register: AddressSourceRegister): string {
	const { contentDigest: _omitted, ...rest } = register

	return sha256Hex(stringifyJSON(rest))
}

/**
 * Whether a register read off disk still hashes to the digest its build wrote.
 *
 * Read-path only, and deliberately not part of {@linkcode auditAddressSourceRegister}.
 * The digest answers whether a file was edited after it was generated, which is a question about a file.
 * The structural audit answers whether a register is well formed, which the build asks about an
 * object it is still assembling and which every test fixture asks about a literal nobody generated.
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

		// A permission is a claim about somebody else's terms, and one with no stated basis
		// cannot be checked against them. A refusal needs none: it withholds rather than asserts.
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
 * Read the committed register, refusing one that fails the audit.
 *
 * @throws When the file does not parse, or when the audit reports anything,
 *   with every problem in the message.
 */
export async function readAddressSourceRegister(path?: string): Promise<AddressSourceRegister> {
	const resolved = path ?? addressSourceRegisterPath()
	const register = await readLocalJSONFile<AddressSourceRegister>(resolved)
	const problems = [...auditContentDigest(register), ...auditAddressSourceRegister(register)]

	if (problems.length) {
		throw new Error(`${resolved} failed the register audit:\n  ${problems.join("\n  ")}`)
	}

	return register
}
