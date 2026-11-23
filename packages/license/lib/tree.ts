// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The go/no-go decision tree: whether an action may proceed over a set of sources,
 *   the path each source took, and what the action owes.
 *
 *   Each source passes the nodes in order, and the first node that doesn't pass stops it.
 *
 *   1. `registered`: the register declares the source's decision, or the source reads `unknown`.
 *   2. `review-state`: an unchecked decision reads `unknown`, and a refused one `no-go`.
 *   3. `reservation`: a source reserved for evaluation (`#reservation`), by choice or by its terms
 *      permitting `evaluate` and refusing `train`, reads `no-go` for an action that requires `train`,
 *      quoting the reservation's reason. A source the register's source list lacks reads `unknown`,
 *      because whether it is reserved can't be read.
 *   4. `operations`: each operation the action requires, in table order.
 *      A refusal reads `no-go`, and an unreviewed operation `unknown`.
 *   5. `purpose`: each purpose the action performs its operations for (`actionPurposes` in `#actions`),
 *      read for each operation, and decided the same way. The node reads after an operation that didn't
 *      pass as well, so the answer lists every unpermitted reading, and a source stops after it when
 *      either node didn't pass.
 *   6. `basis-floor`: an action may require every permission to rest on one basis.
 *   7. `obligations`: collects what the source owes. The node has no refusal edge.
 *
 *   An obligation never refuses. An indemnity allocates liability and restricts no use,
 *   so a decision's operations stand without it, and the same holds for every other obligation class.
 *
 *   The answer is deterministic. Sources are read in sorted order and no step reads a clock,
 *   so the request with the register's content digest fixes it.
 */

import { type ActionRule, actionOperations, actionPurposes, LICENSE_ACTIONS, type LicenseAction } from "#actions"
import {
	type LicenseDecision,
	LicenseReviewState,
	ObligationStrength,
	OperationPermission,
	operationReadingProblem,
	permissionFor,
	purposeFor,
	undeclaredLicenseProblem,
	unelectedLicenseProblem,
	unelectedReadingReason,
	type UsePurpose,
} from "#decision"
import { type LicenseObligation, summarizeLicense } from "#obligations"
import type { SourceOperation } from "#operations"
import { rowsQuotable } from "#quote"
import {
	activeReservation,
	refusingReservation,
	reservationProblem,
	type ActiveReservation,
	type SourceReservation,
} from "#reservation"

/**
 * The nodes of the tree, in the order a source passes them.
 */
export const DecisionNode = {
	Registered: "registered",
	ReviewState: "review-state",
	Reservation: "reservation",
	Operations: "operations",
	Purpose: "purpose",
	BasisFloor: "basis-floor",
	Obligations: "obligations",
} as const

/**
 * One of the {@link DecisionNode} values.
 */
export type DecisionNode = (typeof DecisionNode)[keyof typeof DecisionNode]

/**
 * The tree's three answers.
 */
export const DecisionVerdict = {
	Go: "go",
	NoGo: "no-go",
	/**
	 * The register records too little to decide: no decision, an unchecked one, or an unreviewed operation.
	 */
	Unknown: "unknown",
} as const

/**
 * One of the {@link DecisionVerdict} values.
 */
export type DecisionVerdict = (typeof DecisionVerdict)[keyof typeof DecisionVerdict]

/**
 * One source the request asks about: its id and the license decision it points at.
 */
export interface LicenseRequestSource {
	source: string
	licenseID: string
}

/**
 * What the tree is asked.
 */
export interface LicenseRequest {
	action: LicenseAction
	/**
	 * The license expression the action's result is offered under, or `null` when it offers no artifact.
	 */
	offering: string | null
	sources: readonly LicenseRequestSource[]
}

/**
 * One source the register lists, with the reservation it records.
 */
export interface LicenseRegisterSource {
	sourceID: string
	reservation?: SourceReservation
}

/**
 * The register the tree reads: its decisions, its sources' reservations,
 * and the content digest that identifies them.
 */
export interface LicenseRegister {
	contentDigest?: string
	licenses: readonly LicenseDecision<SourceOperation>[]
	/**
	 * Every source the register lists.
	 *
	 * A request's `source` matches a `sourceID` here.
	 */
	sources: readonly LicenseRegisterSource[]
}

/**
 * One node one source passed or stopped at.
 */
export interface DecisionStep {
	source: string
	node: DecisionNode
	outcome: DecisionVerdict
	/**
	 * The operation an `operations`, `purpose` or `basis-floor` step read.
	 */
	operation?: SourceOperation
	/**
	 * The purpose a `purpose` step read.
	 */
	purpose?: UsePurpose
	/**
	 * The publisher's words the step rests on, when the decision records them.
	 */
	quote: string | null
	/**
	 * The recorded reason for the step's outcome.
	 */
	because: string
}

/**
 * One obligation a source owes under the action.
 */
export interface OwedObligation {
	source: string
	obligation: LicenseObligation
	strength: ObligationStrength
	/**
	 * The publisher's clause, or `null` for an obligation the SPDX identifier's table records.
	 */
	quote: string | null
	/**
	 * The text a notice prints, when the decision records one.
	 */
	text?: string
	/**
	 * The SPDX identifier whose table records the obligation, for an obligation the terms don't quote.
	 */
	identifier?: string
}

/**
 * One source's answer.
 */
export interface SourceAnswer {
	source: string
	licenseID: string
	verdict: DecisionVerdict
	/**
	 * Every reason the source isn't `go`, in node order.
	 */
	problems: string[]
	/**
	 * Whether the source's rows may be quoted verbatim in published text, whatever the action's verdict.
	 *
	 * `rowsQuotable` in `#quote` reads it, and `quoteRow` prints a row by it.
	 */
	quotable: boolean
}

/**
 * The tree's answer to a request.
 */
export interface LicenseAnswer {
	action: LicenseAction
	offering: string | null
	/**
	 * `no-go` when any source reads `no-go`, else `unknown` when any reads `unknown`
	 * or the request lists no source, else `go`.
	 */
	verdict: DecisionVerdict
	sources: SourceAnswer[]
	path: DecisionStep[]
	owed: OwedObligation[]
	/**
	 * The content digest of the register the tree read, or `null` when the register records none.
	 */
	registerDigest: string | null
}

interface SourceWalk {
	answer: SourceAnswer
	path: DecisionStep[]
	owed: OwedObligation[]
}

/**
 * The outcome one operation's reading gives.
 */
function readingOutcome(permission: OperationPermission): DecisionVerdict {
	if (permission === OperationPermission.Permitted) return DecisionVerdict.Go

	return permission === OperationPermission.Refused ? DecisionVerdict.NoGo : DecisionVerdict.Unknown
}

/**
 * Everything an elected decision owes: the obligations its terms record,
 * then those its SPDX identifier's table records.
 */
function owedBy(source: string, decision: LicenseDecision<SourceOperation>): OwedObligation[] {
	if (decision.state !== LicenseReviewState.Elected) return []

	const owed: OwedObligation[] = (decision.obligations ?? []).map((entry) => ({
		source,
		obligation: entry.obligation,
		strength: entry.strength,
		quote: entry.quote,
		...(entry.text == null ? {} : { text: entry.text }),
	}))

	if (decision.spdx) {
		for (const obligation of summarizeLicense(decision.spdx).obligations) {
			owed.push({ source, obligation, strength: ObligationStrength.Required, quote: null, identifier: decision.spdx })
		}
	}

	return owed
}

/**
 * Why the `reservation` node passed a source.
 */
function reservationPassReason(
	recorded: SourceReservation | undefined,
	active: ActiveReservation | null,
	action: LicenseAction
): string {
	if (active) return `the source is reserved for ${active.use}, and ${action} does not train on it`

	if (recorded?.lifted) {
		return `the reservation of ${recorded.since} was lifted on ${recorded.lifted.at} (#${recorded.lifted.issue}): ${recorded.lifted.because}`
	}

	return "the source is not reserved"
}

/**
 * Walks one source through the tree.
 */
function walkSource(
	request: LicenseRequestSource,
	decision: LicenseDecision<SourceOperation> | undefined,
	listed: LicenseRegisterSource | undefined,
	action: LicenseAction,
	rule: ActionRule,
	operations: readonly SourceOperation[],
	purposes: readonly UsePurpose[]
): SourceWalk {
	const { source, licenseID } = request
	const path: DecisionStep[] = []
	const problems: string[] = []
	const quotable = rowsQuotable(decision)

	const step = (entry: Omit<DecisionStep, "source">) => {
		path.push({ source, ...entry })
	}

	const stop = (verdict: DecisionVerdict): SourceWalk => ({
		answer: { source, licenseID, verdict, problems, quotable },
		path,
		owed: [],
	})

	if (!decision) {
		const problem = undeclaredLicenseProblem(licenseID)

		step({ node: DecisionNode.Registered, outcome: DecisionVerdict.Unknown, quote: null, because: problem })
		problems.push(problem)

		return stop(DecisionVerdict.Unknown)
	}

	step({ node: DecisionNode.Registered, outcome: DecisionVerdict.Go, quote: null, because: "the register declares it" })

	if (decision.state !== LicenseReviewState.Elected) {
		const refused = decision.state === LicenseReviewState.Refused
		const outcome = refused ? DecisionVerdict.NoGo : DecisionVerdict.Unknown

		step({
			node: DecisionNode.ReviewState,
			outcome,
			quote: refused ? (decision.reading?.quote ?? null) : null,
			because: refused ? decision.refusedBecause : unelectedReadingReason(decision.state),
		})

		problems.push(unelectedLicenseProblem(licenseID, decision.state))

		return stop(outcome)
	}

	step({ node: DecisionNode.ReviewState, outcome: DecisionVerdict.Go, quote: null, because: decision.electedBecause })

	if (!listed) {
		const problem = `the register lists no source ${JSON.stringify(source)}, so whether it is reserved cannot be read`

		step({ node: DecisionNode.Reservation, outcome: DecisionVerdict.Unknown, quote: null, because: problem })
		problems.push(problem)

		return stop(DecisionVerdict.Unknown)
	}

	const refusing = refusingReservation(listed.reservation, decision, operations)

	if (refusing) {
		const problem = reservationProblem(source, refusing)

		step({ node: DecisionNode.Reservation, outcome: DecisionVerdict.NoGo, quote: null, because: refusing.because })
		problems.push(problem)

		return stop(DecisionVerdict.NoGo)
	}

	step({
		node: DecisionNode.Reservation,
		outcome: DecisionVerdict.Go,
		quote: null,
		because: reservationPassReason(listed.reservation, activeReservation(listed.reservation, decision), action),
	})

	const outcomes = new Set<DecisionVerdict>()

	for (const operation of operations) {
		const reading = permissionFor(decision, operation)
		const outcome = readingOutcome(reading.permission)

		step({ node: DecisionNode.Operations, operation, outcome, quote: null, because: reading.because })
		outcomes.add(outcome)

		if (outcome !== DecisionVerdict.Go) {
			problems.push(operationReadingProblem(operation, reading))
		}
	}

	// A purpose read from the decision's defaults is one reading for every operation,
	// so its problem is listed once.
	const purposeProblems = new Set<string>()

	for (const purpose of purposes) {
		for (const operation of operations) {
			const { reading, label } = purposeFor(decision, operation, purpose)
			const outcome = readingOutcome(reading.permission)

			step({ node: DecisionNode.Purpose, operation, purpose, outcome, quote: null, because: reading.because })
			outcomes.add(outcome)

			if (outcome !== DecisionVerdict.Go) {
				purposeProblems.add(operationReadingProblem(label, reading))
			}
		}
	}

	problems.push(...purposeProblems)

	if (outcomes.has(DecisionVerdict.NoGo)) return stop(DecisionVerdict.NoGo)

	if (outcomes.has(DecisionVerdict.Unknown)) return stop(DecisionVerdict.Unknown)

	const floor = rule.basisFloor

	for (const operation of floor ? operations : []) {
		const { basis } = permissionFor(decision, operation)

		if (basis === floor) continue

		const problem = `the elected terms permit ${operation} on ${basis ?? "no recorded basis"}, and ${action} requires ${floor}`

		step({ node: DecisionNode.BasisFloor, operation, outcome: DecisionVerdict.NoGo, quote: null, because: problem })
		problems.push(problem)
	}

	if (problems.length) return stop(DecisionVerdict.NoGo)

	step({
		node: DecisionNode.BasisFloor,
		outcome: DecisionVerdict.Go,
		quote: null,
		because: floor ? `every permission rests on ${floor}` : "the action sets no floor",
	})

	const owed = owedBy(source, decision)

	// The obligations node has no refusal edge: whatever a source owes, the action proceeds and owes it.
	step({
		node: DecisionNode.Obligations,
		outcome: DecisionVerdict.Go,
		quote: null,
		because: `${owed.length} obligation(s) owed`,
	})

	return { answer: { source, licenseID, verdict: DecisionVerdict.Go, problems, quotable }, path, owed }
}

function compareSources(left: LicenseRequestSource, right: LicenseRequestSource): number {
	if (left.source !== right.source) return left.source < right.source ? -1 : 1

	if (left.licenseID !== right.licenseID) return left.licenseID < right.licenseID ? -1 : 1

	return 0
}

/**
 * Answers whether `request.action` may proceed over `request.sources` under `register`'s decisions.
 *
 * A license id the register declares twice reads its first declaration, as the register's other readers do.
 */
export function evaluateLicense(request: LicenseRequest, register: LicenseRegister): LicenseAnswer {
	const rule = LICENSE_ACTIONS[request.action]
	const operations = actionOperations(request.action)
	const purposes = actionPurposes(request.action, request.offering)

	const walks = request.sources.toSorted(compareSources).map((source) =>
		walkSource(
			source,
			register.licenses.find((entry) => entry.licenseID === source.licenseID),
			register.sources.find((entry) => entry.sourceID === source.source),
			request.action,
			rule,
			operations,
			purposes
		)
	)

	const verdicts = new Set(walks.map(({ answer }) => answer.verdict))

	let verdict: DecisionVerdict = DecisionVerdict.Go

	if (verdicts.has(DecisionVerdict.NoGo)) {
		verdict = DecisionVerdict.NoGo
	} else if (verdicts.has(DecisionVerdict.Unknown) || !walks.length) {
		verdict = DecisionVerdict.Unknown
	}

	return {
		action: request.action,
		offering: request.offering,
		verdict,
		sources: walks.map(({ answer }) => answer),
		path: walks.flatMap((walk) => walk.path),
		owed: walks.flatMap((walk) => walk.owed),
		registerDigest: register.contentDigest ?? null,
	}
}
