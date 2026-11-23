// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Evaluation reservations: an address source held out of every training corpus so its rows
 *   stay unseen by every model, and the reading the decision tree's `reservation` node takes of one.
 *
 *   A source is reserved in one of two ways.
 *
 *   - By choice: the register records a {@link SourceReservation} on the source. The operator lifts it by
 *     filling {@link SourceReservation.lifted}, and the entry stays as the record of the reservation.
 *   - By terms: computed and never stored, for a source whose decision permits `evaluate` and refuses
 *     `train`. Only a new reading of the terms lifts it.
 */

import { type LicenseDecision, OperationPermission, permissionFor } from "#decision"
import { SourceOperation } from "#operations"

/**
 * What a reservation holds a source for.
 */
export const ReservationUse = {
	/**
	 * Rows rendered into an evaluation collection and kept out of every training corpus.
	 */
	Evaluation: "evaluation",
} as const

/**
 * One of the {@link ReservationUse} values.
 */
export type ReservationUse = (typeof ReservationUse)[keyof typeof ReservationUse]

/**
 * The reservation of every row a source publishes.
 */
export const SOURCE_RESERVATION_SCOPE = "source"

/**
 * Which of a source's rows a reservation covers: every row, or the groups a list names.
 */
export type ReservationScope = typeof SOURCE_RESERVATION_SCOPE | { groups: string }

/**
 * The record of a reservation the operator lifted.
 */
export interface ReservationLift {
	/**
	 * An ISO 8601 calendar date in the form `YYYY-MM-DD`.
	 */
	at: string
	because: string
	issue: number
	/**
	 * Every held-out dataset that froze rows from the source.
	 *
	 * The lifted reservation retires each one from release grading.
	 */
	retires: readonly string[]
}

/**
 * The reservation a register source records.
 */
export interface SourceReservation {
	use: ReservationUse
	scope: ReservationScope
	/**
	 * An ISO 8601 calendar date in the form `YYYY-MM-DD`.
	 */
	since: string
	because: string
	issue: number
	lifted?: ReservationLift
}

/**
 * How a source came to be reserved.
 */
export const ReservationOrigin = {
	/**
	 * The register records the reservation.
	 */
	Choice: "choice",
	/**
	 * The source's decision permits `evaluate` and refuses `train`, so the source can only be evaluated on.
	 */
	Terms: "terms",
} as const

/**
 * One of the {@link ReservationOrigin} values.
 */
export type ReservationOrigin = (typeof ReservationOrigin)[keyof typeof ReservationOrigin]

/**
 * A reservation in force on a source.
 */
export interface ActiveReservation {
	origin: ReservationOrigin
	use: ReservationUse
	scope: ReservationScope
	because: string
	/**
	 * The recorded reservation, for one reserved by choice.
	 */
	recorded: SourceReservation | null
}

/**
 * The reservation in force on a source, or `null` when none is.
 *
 * A recorded reservation with `lifted` filled is no longer in force.
 */
export function activeReservation(
	recorded: SourceReservation | null | undefined,
	decision: LicenseDecision<SourceOperation>
): ActiveReservation | null {
	if (recorded && !recorded.lifted) {
		return {
			origin: ReservationOrigin.Choice,
			use: recorded.use,
			scope: recorded.scope,
			because: recorded.because,
			recorded,
		}
	}

	const training = permissionFor(decision, SourceOperation.Train)

	if (training.permission !== OperationPermission.Refused) return null

	if (permissionFor(decision, SourceOperation.Evaluate).permission !== OperationPermission.Permitted) return null

	return {
		origin: ReservationOrigin.Terms,
		use: ReservationUse.Evaluation,
		scope: SOURCE_RESERVATION_SCOPE,
		because: `the decision permits evaluate and refuses train, so the source can only be evaluated on: ${training.because}`,
		recorded: null,
	}
}

/**
 * The reservation that refuses an act performing `operations` on a source, or `null` when none does.
 *
 * A reservation for evaluation refuses only an act that performs `train`.
 */
export function refusingReservation(
	recorded: SourceReservation | null | undefined,
	decision: LicenseDecision<SourceOperation>,
	operations: readonly SourceOperation[]
): ActiveReservation | null {
	if (!operations.includes(SourceOperation.Train)) return null

	return activeReservation(recorded, decision)
}

/**
 * The problem a training action over a reserved source reads.
 */
export function reservationProblem(source: string, reservation: ActiveReservation): string {
	const recorded = reservation.recorded
	const origin = recorded ? `since ${recorded.since} (#${recorded.issue})` : "by its terms"

	const scope =
		reservation.scope === SOURCE_RESERVATION_SCOPE
			? ""
			: `, for the groups listed in ${reservation.scope.groups}, and no build filters a reserved group out yet`

	return `${source} is reserved for ${reservation.use} ${origin}${scope}: ${reservation.because}`
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u

const RESERVATION_USES = new Set<string>(Object.values(ReservationUse))

/**
 * One message for each structural problem in a recorded reservation.
 *
 * A reservation states its use, its scope, the date it began, its reason and its issue.
 * A lift states its date, reason, issue and the datasets it retires.
 */
export function auditSourceReservation(source: string, reservation: SourceReservation): string[] {
	const problems: string[] = []
	const named = JSON.stringify(source)

	if (!RESERVATION_USES.has(reservation.use)) {
		problems.push(`source ${named} is reserved for ${JSON.stringify(reservation.use)}, which is not a reservation use`)
	}

	const scope = reservation.scope as unknown

	const scoped =
		scope === SOURCE_RESERVATION_SCOPE ||
		(typeof scope === "object" &&
			scope != null &&
			typeof (scope as { groups?: unknown }).groups === "string" &&
			Boolean((scope as { groups: string }).groups))

	if (!scoped) {
		problems.push(`source ${named} carries a reservation scope that is neither "source" nor { groups: <path> }`)
	}

	if (typeof reservation.since !== "string" || !CALENDAR_DATE.test(reservation.since)) {
		problems.push(`source ${named} carries a reservation whose \`since\` is not a YYYY-MM-DD date`)
	}

	if (typeof reservation.because !== "string" || !reservation.because.trim()) {
		problems.push(`source ${named} carries a reservation that states no reason`)
	}

	if (!Number.isInteger(reservation.issue) || reservation.issue <= 0) {
		problems.push(`source ${named} carries a reservation that names no issue`)
	}

	const lifted = reservation.lifted

	if (!lifted) return problems

	if (typeof lifted.at !== "string" || !CALENDAR_DATE.test(lifted.at)) {
		problems.push(`source ${named} carries a lifted reservation whose \`at\` is not a YYYY-MM-DD date`)
	} else if (CALENDAR_DATE.test(reservation.since) && lifted.at < reservation.since) {
		problems.push(
			`source ${named} carries a reservation lifted on ${lifted.at}, before it began on ${reservation.since}`
		)
	}

	if (typeof lifted.because !== "string" || !lifted.because.trim()) {
		problems.push(`source ${named} carries a lifted reservation that states no reason for the lift`)
	}

	if (!Number.isInteger(lifted.issue) || lifted.issue <= 0) {
		problems.push(`source ${named} carries a lifted reservation that names no issue for the lift`)
	}

	if (!Array.isArray(lifted.retires)) {
		problems.push(`source ${named} carries a lifted reservation with no \`retires\` list`)
	}

	return problems
}
