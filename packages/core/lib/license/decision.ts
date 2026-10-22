/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A license decision records three things: whether a person read a publisher's terms, the grant they elected, and
 *   what that grant permits for each act this repository performs on the publisher's data.
 *
 *   Every register of third-party data uses this shape: the address-source register in `@mailwoman/corpus` and the
 *   building and landmark register in `@mailwoman/structures`. Each register defines its own operation list, such as
 *   `train` for an address corpus or `convert` for a building model, and passes it as the `Operation` parameter.
 *
 *   {@linkcode LicenseResolution} in `#license/record` answers a different question. It records whether a license
 *   string mapped to an expression with known obligations, whereas a decision records a person's review of terms.
 */

import { stringifyJSON } from "#json"

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
	 * It does not establish which grant governs, and `electedBecause` states
	 * the substantive ground separately.
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
 * The result is `unreviewed` when the decision is not elected or does not mention the operation.
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
 * Returns a reason for every operation the decision does not permit,
 * or an empty array when it permits them all.
 *
 * `licenseID` is the id the source row points at.
 * A decision that is absent, unchecked or refused yields one reason naming that state.
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
			return decision.refusedBecause ? [] : [`license ${named} is refused and gives no reason`]

		case LicenseReviewState.Elected:
			return auditElected(decision, named, knownOperations)

		default:
			return [`license ${named} carries an unknown review state`]
	}
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

	return problems
}
