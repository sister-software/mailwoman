// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The request side of outcome kinds: the two request fields, their refusals,
 *   and the sets the resolver and the data layers read.
 *
 *   `docs/engineering/reference/outcome-kinds.mdx` is the design, and `#outcome/kinds` is the vocabulary.
 */

import { OUTCOME_KINDS, type OutcomeKind } from "#outcome/kinds"
import { currentOutcomeKind, isOutcomeKind, outcomeSatisfies } from "#outcome/satisfy"

/**
 * The two outcome fields of a geocode request.
 */
export interface OutcomeOptions {
	/**
	 * The reading the caller expects.
	 *
	 * The resolver orders candidates that satisfy it first, inside each conformance class, and removes none.
	 */
	outcomeHint?: OutcomeKind
	/**
	 * The readings the caller admits.
	 *
	 * A record is admissible when it satisfies one id in the list.
	 * Each data layer applies it inside its own query, before its row limit.
	 */
	outcomeFilter?: readonly OutcomeKind[]
}

/**
 * One member of a resolved place's outcome set.
 */
export interface OutcomeMembership {
	outcome: OutcomeKind
	/**
	 * True when one source asserts the member and another denies it.
	 * The member stays in the set.
	 */
	contested: boolean
	/**
	 * Where the member came from, one entry per data layer and kind of evidence,
	 * such as `candidate:default` or `landmarks:asserted`.
	 */
	sources: readonly string[]
}

/**
 * What a data layer's query reads of the outcome request.
 */
export interface OutcomeQuery {
	/**
	 * The `mw:id`s a row must hold one of to be read, or `null` to read every row.
	 *
	 * The resolver expands a request id to itself and every member whose parent it is.
	 */
	readonly admit: readonly number[] | null
}

/**
 * The data layers a span's outcome-ordered candidate list reads, in the order their
 * candidates follow when cross-layer prominence is missing.
 */
export const OutcomeLayer = {
	Candidate: "candidate",
	Landmarks: "landmarks",
	OpenStreetMap: "openstreetmap",
} as const

export type OutcomeLayer = (typeof OutcomeLayer)[keyof typeof OutcomeLayer]

/**
 * The outcome request a resolve reads, checked against the vocabulary.
 */
export interface ResolveOutcome {
	readonly hint: OutcomeKind | null
	readonly filter: readonly OutcomeKind[] | null
	/**
	 * The outcome head's identity top levels, most probable first, when the head's
	 * ordering is on and the query is eligible for it, and `null` otherwise.
	 */
	readonly headOrder: readonly OutcomeKind[] | null
}

/**
 * The outcome tables a compiled database holds.
 */
export const OUTCOME_TABLES = ["outcome_default", "record_outcome"] as const

/**
 * Why an outcome request was refused.
 */
export const OutcomeRefusal = {
	/**
	 * An id that isn't a member of the vocabulary.
	 */
	UnknownOutcome: "unknown_outcome",
	/**
	 * A hint that zero filter ids admit.
	 */
	HintOutsideFilter: "hint_outside_filter",
	/**
	 * A database built before the outcome tables.
	 */
	MissingOutcomeTables: "missing_outcome_tables",
} as const

export type OutcomeRefusal = (typeof OutcomeRefusal)[keyof typeof OutcomeRefusal]

/**
 * A refused outcome request.
 * An HTTP surface answers it with status 400.
 */
export class OutcomeRequestError extends Error {
	readonly code: OutcomeRefusal

	constructor(code: OutcomeRefusal, message: string) {
		super(message)
		this.name = "OutcomeRequestError"
		this.code = code
	}
}

/**
 * The vocabulary member each `mw:id` names.
 */
// Computed once from the generated table, a constant of the build.
const KIND_OF_ID: ReadonlyMap<number, OutcomeKind> = new Map(
	(Object.keys(OUTCOME_KINDS) as OutcomeKind[]).map((kind) => [OUTCOME_KINDS[kind].id, kind])
)

/**
 * The vocabulary member an `mw:id` names, read through its replacement when deprecated,
 * or null for an id the vocabulary doesn't hold.
 */
export function outcomeKindOfID(id: number): OutcomeKind | null {
	const kind = KIND_OF_ID.get(id)

	return kind ? currentOutcomeKind(kind) : null
}

/**
 * Whether a set of members satisfies one id of `requested`.
 */
export function outcomesSatisfy(
	requested: readonly OutcomeKind[],
	members: readonly Pick<OutcomeMembership, "outcome">[]
): boolean {
	return members.some((m) => requested.some((id) => outcomeSatisfies(m.outcome, id)))
}

/**
 * The `mw:id`s of every vocabulary member that satisfies one of `requested`.
 */
export function admittedOutcomeIDs(requested: readonly OutcomeKind[]): number[] {
	return (Object.keys(OUTCOME_KINDS) as OutcomeKind[])
		.filter((member) => requested.some((id) => outcomeSatisfies(member, id)))
		.map((member) => OUTCOME_KINDS[member].id)
}

/**
 * Whether the request sets either outcome field.
 */
export function hasOutcomeOptions(options: OutcomeOptions | null | undefined): boolean {
	return !!options && (typeof options.outcomeHint === "string" || Array.isArray(options.outcomeFilter))
}

function kindOf(id: string): OutcomeKind {
	if (!isOutcomeKind(id)) {
		throw new OutcomeRequestError(
			OutcomeRefusal.UnknownOutcome,
			`"${id}" isn't an outcome kind. The vocabulary holds ${Object.keys(OUTCOME_KINDS).join(", ")}.`
		)
	}

	return currentOutcomeKind(id)
}

/**
 * The outcome fields of a request as a caller wrote them, checked against the vocabulary.
 * A deprecated id is read through its replacement.
 *
 * @throws {OutcomeRequestError} For an id outside the vocabulary or a hint that zero filter ids admit.
 */
export function parseOutcomeOptions(raw: {
	outcomeHint?: string | null
	outcomeFilter?: readonly string[] | null
}): OutcomeOptions {
	const hint = raw.outcomeHint != null ? kindOf(raw.outcomeHint) : null
	const filter = raw.outcomeFilter ? raw.outcomeFilter.map(kindOf) : null

	if (hint && filter && !filter.some((id) => outcomeSatisfies(hint, id))) {
		throw new OutcomeRequestError(
			OutcomeRefusal.HintOutsideFilter,
			`The hint "${hint}" is outside the filter [${filter.join(", ")}], so it can't be satisfied.`
		)
	}

	return { ...(hint ? { outcomeHint: hint } : {}), ...(filter ? { outcomeFilter: filter } : {}) }
}

/**
 * Refuses a database that lacks an outcome table.
 *
 * @throws {OutcomeRequestError} Naming the database and every missing table.
 */
export function refuseMissingOutcomeTables(database: string, missing: readonly string[]): void {
	if (!missing.length) return

	throw new OutcomeRequestError(
		OutcomeRefusal.MissingOutcomeTables,
		`${database} predates outcome kinds: it lacks ${missing.join(" and ")}, so it can't answer outcomeHint or outcomeFilter.`
	)
}

/**
 * Merges two outcome sets, keeping each member once with the union of its sources.
 * A member is contested when either side marks it so.
 */
export function unionOutcomes(a: readonly OutcomeMembership[], b: readonly OutcomeMembership[]): OutcomeMembership[] {
	const merged = new Map<OutcomeKind, OutcomeMembership>()

	for (const member of [...a, ...b]) {
		const held = merged.get(member.outcome)

		merged.set(
			member.outcome,
			held
				? {
						outcome: member.outcome,
						contested: held.contested || member.contested,
						sources: [...new Set([...held.sources, ...member.sources])],
					}
				: { ...member, sources: [...member.sources] }
		)
	}

	return [...merged.values()].toSorted((x, y) => x.outcome.localeCompare(y.outcome))
}
