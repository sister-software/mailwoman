// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A license decision records three things: whether a person read a publisher's terms,
 *   the grant they elected, and what that grant permits for each act this
 *   repository performs on the publisher's data.
 *
 *   Every register of third-party data uses this shape: the address-source register in
 *   `@mailwoman/corpus` and the building and landmark register in `@mailwoman/structures`.
 *   Each register defines its own operation list, such as `train` for an address corpus
 *   or `convert` for a building model, and passes it as the `Operation` parameter.
 *
 *   {@linkcode LicenseResolution} in `#license/record` answers a different question.
 *   It records whether a license string mapped to an expression with known obligations,
 *   whereas a decision records a person's review of terms.
 */

import { stringifyJSON } from "#json"
import { LicenseObligation } from "#license/obligations"

/**
 * The review state of a source's terms.
 *
 * Only an `elected` decision can admit a source into any build.
 */
export const LicenseReviewState = {
	/**
	 * The publisher's terms have no review record.
	 *
	 * The research pass's license text is kept verbatim in
	 * {@linkcode UncheckedLicense.publisherStatement} and grants no license.
	 */
	Unchecked: "unchecked",
	/**
	 * A reviewer read the terms, elected one grant, retrieved a copy and recorded the reason.
	 */
	Elected: "elected",
	/**
	 * A reviewer read the terms and rejected the source.
	 * The row records the reason.
	 */
	Refused: "refused",
} as const

/**
 * One of the {@link LicenseReviewState} values.
 */
export type LicenseReviewState = (typeof LicenseReviewState)[keyof typeof LicenseReviewState]

/**
 * A license decision whose terms have no review record.
 */
export interface UncheckedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Unchecked
	/**
	 * The research pass's license text, verbatim.
	 *
	 * Most values are access labels such as `Free` or `Licensed` that make no
	 * statement about redistribution or adaptation.
	 */
	publisherStatement: string
	note: string
}

/**
 * What a grant permits for one operation.
 *
 * `unreviewed` means the terms lack an operation-specific review.
 * Eligibility checks treat it as blocking.
 * The state stays distinct from `refused`.
 */
export const OperationPermission = {
	Permitted: "permitted",
	Refused: "refused",
	Unreviewed: "unreviewed",
} as const

/**
 * One of the {@link OperationPermission} values.
 */
export type OperationPermission = (typeof OperationPermission)[keyof typeof OperationPermission]

/**
 * The legal basis of a permission.
 *
 * Most permissions rest on a publisher grant.
 * The other values mark permissions with a different basis.
 */
export const PermissionBasis = {
	PublisherGrant: "publisher-grant",
	StatutoryException: "statutory-exception",
	OtherDocumented: "other-documented",
} as const

/**
 * One of the {@link PermissionBasis} values.
 */
export type PermissionBasis = (typeof PermissionBasis)[keyof typeof PermissionBasis]

/**
 * The permission recorded for one operation, with its basis and reason.
 */
export interface OperationDecision {
	permission: OperationPermission
	/**
	 * The audit requires a permission basis when the permission is `permitted`.
	 */
	basis?: PermissionBasis
	/**
	 * The relevant sentence in the terms, or the reason for a refusal.
	 */
	because: string
}

/**
 * What a reviewer found on the page that holds a publisher's terms.
 */
export const TermsStatement = {
	/**
	 * The publisher states terms: a license, a use clause, or a disclaimer.
	 */
	Terms: "terms",
	/**
	 * Every field the reviewer read was empty or only described the data, so the publisher states no terms.
	 *
	 * This is a finding about the page, kept apart from terms that were read and found not to restrict.
	 */
	NoStatement: "no-statement",
	/**
	 * The dataset's own metadata states no terms, and the reviewer found site-wide
	 * terms on the publisher's website.
	 *
	 * The decision doesn't read the site terms as the dataset's grant.
	 * Its `operations` record what it decides about them, such as a refused `redistribute-data`.
	 */
	SiteTermsNotApplied: "site-terms-not-applied",
} as const

/**
 * One of the {@link TermsStatement} values.
 */
export type TermsStatement = (typeof TermsStatement)[keyof typeof TermsStatement]

/**
 * Where a reviewer read a publisher's terms, and what was there.
 *
 * A decision that records none has its terms page only in its prose and its retrieved copy.
 */
export interface TermsReading {
	/**
	 * The page or metadata record that holds the publisher's terms, such as an ArcGIS item's JSON.
	 */
	url: string
	found: TermsStatement
	/**
	 * The publisher's words, verbatim, or the empty fields the reviewer read.
	 */
	quote?: string
}

/**
 * Whether a publisher's terms make an obligation a condition or ask for it.
 */
export const ObligationStrength = {
	/**
	 * The terms impose it: `must`, `shall`, `agrees to`, or a grant void without it.
	 */
	Required: "required",
	/**
	 * The terms ask for it without making it a condition: `is requested`, `is appreciated`, `should`.
	 */
	Requested: "requested",
} as const

/**
 * One of the {@link ObligationStrength} values.
 */
export type ObligationStrength = (typeof ObligationStrength)[keyof typeof ObligationStrength]

/**
 * One obligation a publisher's terms place on a user of the data, in the publisher's words.
 *
 * The data bill of materials, `mailwoman doctor` and a mixed layer's attribution
 * notice read these, so a condition the terms impose reaches them as a record
 * rather than as a clause of a decision's prose.
 */
export interface TermsObligation {
	obligation: LicenseObligation
	strength: ObligationStrength
	/**
	 * The publisher's clause, verbatim.
	 */
	quote: string
	/**
	 * The text a notice prints verbatim, when the clause states a requirement around it: the
	 * credit an attribution requires, or the disclaimer a notice-pass-through requires to travel.
	 *
	 * It is the publisher's words taken from the quote, or the publisher's own template
	 * filled with the values the template asks for, as OGDL-Taiwan-1.0's annex prescribes.
	 * `because` then states which values filled it.
	 *
	 * A notice prints the quote where a notice-pass-through records no text,
	 * and an attribution without one credits the publisher by name.
	 */
	text?: string
	/**
	 * Why the reviewer classed the clause this way, where the quote leaves it open.
	 */
	because?: string
}

/**
 * The text a notice prints for an obligation: its `text`, else the whole clause.
 */
export function obligationNoticeText(obligation: TermsObligation): string {
	return obligation.text ?? obligation.quote
}

/**
 * A license decision whose terms a reviewer read and under which one grant was elected.
 */
export interface ElectedLicense<Operation extends string = string> {
	licenseID: string
	state: typeof LicenseReviewState.Elected
	/**
	 * The elected terms as the publisher names them, such as `Licence Ouverte 2.0`.
	 */
	electedTerms: string
	/**
	 * The SPDX identifier, when one applies.
	 *
	 * {@linkcode electedTermsLabel} prefers this value to {@linkcode ElectedLicense.electedTerms}.
	 */
	spdx?: string
	/**
	 * Every grant the publisher states, where its surfaces state more than one.
	 *
	 * A publisher may state different terms in its dataset metadata, its download service
	 * and its website, and it may be offering the same material under more than one license.
	 * Creative Commons permits that.
	 *
	 * Where that happens, {@linkcode ElectedLicense.spdx} records the one a build filters on
	 * and this records what the publisher said, so a later reviewer reads the conflict
	 * rather than one reading presented as settled.
	 *
	 * The engineering policy elects the strictest grant for what a release may include.
	 * It doesn't establish which grant governs, and `electedBecause` states the substantive ground separately.
	 */
	candidateGrants?: readonly string[]
	termsVersion?: string
	/**
	 * The location of the retrieved copy of the terms, so later reviewers read the same text.
	 */
	retrievedCopy: string
	retrievedAt?: string
	/**
	 * The reason for electing this grant, or a note that the source offers only one.
	 */
	electedBecause: string
	reading?: TermsReading
	/**
	 * Every obligation the elected terms impose beyond what the SPDX identifier's own table records.
	 *
	 * An absent field adds no obligation.
	 * An elected open license still owes what its identifier owes.
	 *
	 * An obligation, an `indemnity` included, decides no operation's permission.
	 * An indemnity allocates liability and restricts no use, so the decision's operations stand without it.
	 */
	obligations?: readonly TermsObligation[]
	/**
	 * The permission for each reviewed operation.
	 *
	 * An omitted operation reads as `unreviewed`.
	 */
	operations?: Partial<Record<Operation, OperationDecision>>
}

/**
 * A license decision whose terms a reviewer read and refused.
 */
export interface RefusedLicense {
	licenseID: string
	state: typeof LicenseReviewState.Refused
	publisherStatement?: string
	refusedBecause: string
	reading?: TermsReading
}

/**
 * A license decision in any review state.
 */
export type LicenseDecision<Operation extends string = string> =
	| UncheckedLicense
	| ElectedLicense<Operation>
	| RefusedLicense

/**
 * Returns the label a share-alike or exclusion filter matches by prefix: the SPDX identifier
 * when one is recorded, otherwise the publisher's name for the terms.
 *
 * The function returns `null` until someone has elected terms for the decision.
 */
export function electedTermsLabel(decision: LicenseDecision): string | null {
	if (decision.state !== LicenseReviewState.Elected) return null

	return decision.spdx ?? decision.electedTerms
}

/**
 * Returns the recorded permission for one operation under a license decision.
 *
 * The result is `unreviewed` when the decision isn't elected or doesn't mention the operation.
 * The selected terms establish which terms apply.
 * Each operation still needs its own review.
 */
export function permissionFor<Operation extends string>(
	decision: LicenseDecision<Operation>,
	operation: Operation
): OperationDecision {
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
 * Returns a reason for every operation the decision doesn't permit,
 * or an empty array when it permits them all.
 *
 * `licenseID` is the id the source row points at.
 * A decision that's absent, unchecked or refused yields one reason naming that state.
 */
export function operationProblems<Operation extends string>(
	licenseID: string,
	decision: LicenseDecision<Operation> | undefined,
	operations: readonly Operation[]
): string[] {
	const named = stringifyJSON(licenseID)

	if (!decision) return [`license ${named} is not declared in the register`]

	if (decision.state !== LicenseReviewState.Elected) {
		return [`license ${named} is ${decision.state}, and only elected terms admit a source`]
	}

	const problems: string[] = []

	for (const operation of operations) {
		const reading = permissionFor(decision, operation)

		if (reading.permission === OperationPermission.Permitted) continue

		problems.push(`the elected terms read ${reading.permission} for ${operation}: ${reading.because}`)
	}

	return problems
}

/**
 * Returns every problem with one decision's own record, given the operations its register performs.
 *
 * A register's audit adds the checks that span decisions, such as a duplicate id
 * or a decision no source points at.
 */
export function auditLicenseDecision<Operation extends string>(
	decision: LicenseDecision<Operation>,
	knownOperations: readonly Operation[]
): string[] {
	const named = stringifyJSON(decision.licenseID)

	switch (decision.state) {
		case LicenseReviewState.Unchecked:
			return decision.publisherStatement ? [] : [`license ${named} is unchecked and records no publisher statement`]

		case LicenseReviewState.Refused:
			return [
				...(decision.refusedBecause ? [] : [`license ${named} is refused and gives no reason`]),
				...auditReading(decision.reading, named),
				// A refusal rests on terms that spell out a restriction, and a page with an empty statement holds none.
				...(decision.reading?.found === TermsStatement.NoStatement
					? [`license ${named} is refused on a reading that found no statement`]
					: []),
			]

		case LicenseReviewState.Elected:
			return [...auditElected(decision, named, knownOperations), ...auditReading(decision.reading, named)]

		default:
			return [`license ${named} carries an unknown review state`]
	}
}

const TERMS_STATEMENTS = new Set<string>(Object.values(TermsStatement))

function auditReading(reading: TermsReading | undefined, named: string): string[] {
	if (!reading) return []

	const problems: string[] = []

	if (!reading.url) {
		problems.push(`license ${named} records a terms reading with no URL`)
	}

	if (!TERMS_STATEMENTS.has(reading.found)) {
		problems.push(`license ${named} records an unknown terms finding ${stringifyJSON(reading.found)}`)
	}

	return problems
}

function auditElected<Operation extends string>(
	decision: ElectedLicense<Operation>,
	named: string,
	knownOperations: readonly Operation[]
): string[] {
	const problems: string[] = []
	const known = new Set<string>(knownOperations)
	const permissions = new Set<string>(Object.values(OperationPermission))

	if (!decision.electedTerms) {
		problems.push(`license ${named} is elected and names no terms`)
	}

	if (!decision.retrievedCopy) {
		problems.push(`license ${named} is elected and names no retrieved copy`)
	}

	if (!decision.electedBecause) {
		problems.push(`license ${named} is elected and gives no reason`)
	}

	for (const [operation, reading] of Object.entries<OperationDecision | undefined>(decision.operations ?? {})) {
		if (!reading) continue

		if (!reading.because) {
			problems.push(`license ${named} reads ${reading.permission} for ${operation} and gives no reason`)
		}

		// A permission must cite its basis in the terms so that a reviewer can check it.
		// A refusal needs no basis.
		if (reading.permission === OperationPermission.Permitted && !reading.basis) {
			problems.push(`license ${named} permits ${operation} and names no basis for the permission`)
		}

		if (!permissions.has(reading.permission)) {
			problems.push(
				`license ${named} reads an unknown permission ${stringifyJSON(reading.permission)} for ${operation}`
			)
		}

		if (!known.has(operation)) {
			problems.push(
				`license ${named} names ${stringifyJSON(operation)}, which is not an operation this repository performs`
			)
		}
	}

	problems.push(...auditObligations(decision, named))

	return problems
}

const LICENSE_OBLIGATIONS = new Set<string>(Object.values(LicenseObligation))
const OBLIGATION_STRENGTHS = new Set<string>(Object.values(ObligationStrength))

/**
 * Every problem with a decision's recorded obligations.
 *
 * Each entry, an `indemnity` included, needs a known class, a known strength and the publisher's words.
 * An obligation states what the user owes and decides no operation's permission.
 */
function auditObligations<Operation extends string>(decision: ElectedLicense<Operation>, named: string): string[] {
	const problems: string[] = []

	for (const entry of decision.obligations ?? []) {
		if (!LICENSE_OBLIGATIONS.has(entry.obligation)) {
			problems.push(`license ${named} records an unknown obligation ${stringifyJSON(entry.obligation)}`)
		}

		if (!OBLIGATION_STRENGTHS.has(entry.strength)) {
			problems.push(
				`license ${named} records ${entry.obligation} with an unknown strength ${stringifyJSON(entry.strength)}`
			)
		}

		if (!entry.quote) {
			problems.push(`license ${named} records ${entry.obligation} without the publisher's words`)
		}

		if (entry.text != null && !entry.text) {
			problems.push(`license ${named} records ${entry.obligation} with an empty notice text`)
		}
	}

	return problems
}
