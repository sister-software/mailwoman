// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The request side of outcome kinds: the two request fields, their refusals,
 *   and the satisfaction rule the resolver and the data layers share.
 *
 *   `docs/engineering/reference/outcome-kinds.mdx` is the design.
 *   An outcome id is a top-level name or a top-level name and one second-level name joined by a dot.
 *
 *   A record satisfies an id when one of its members equals it or begins with it and a dot.
 */

/**
 * One member of the outcome vocabulary, as the compiled definitions state it.
 *
 * `OUTCOME_VOCABULARY` in `@mailwoman/gazetteer/whosonfirst/outcomes/vocabulary` is the
 * vocabulary's home, and this shape is the part of each row the resolver reads.
 */
export interface OutcomeVocabularyLike {
	/**
	 * The `mw:id` a compiled database stores in its `outcome_id` columns.
	 */
	readonly id: number
	/**
	 * The `mw:name`, such as `natural.mountain`.
	 */
	readonly name: string
	/**
	 * The `mw:facet`: `identity` states what a record is, `role` how people use it.
	 */
	readonly facet: "identity" | "role"
}

/**
 * The two outcome fields of a geocode request.
 */
export interface OutcomeOptions {
	/**
	 * The reading the caller expects.
	 *
	 * The resolver orders candidates that satisfy it first, inside each conformance class, and removes none.
	 */
	outcomeHint?: string
	/**
	 * The readings the caller admits.
	 *
	 * A record is admissible when it satisfies one id in the list.
	 * Each data layer applies it inside its own query, before its row limit.
	 */
	outcomeFilter?: readonly string[]
}

/**
 * One member of a resolved place's outcome set.
 */
export interface OutcomeMembership {
	outcome: string
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
	readonly vocabulary: readonly OutcomeVocabularyLike[]
	/**
	 * The `mw:id`s a row must hold one of to be read, or `null` to read every row.
	 *
	 * The resolver expands a request id to itself and every member it is a prefix of.
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
	readonly vocabulary: readonly OutcomeVocabularyLike[]
	readonly hint: string | null
	readonly filter: readonly string[] | null
	/**
	 * The outcome head's identity top levels, most probable first, when the head's
	 * ordering is on and the query is eligible for it, and `null` otherwise.
	 */
	readonly headOrder: readonly string[] | null
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
	/**
	 * A geocoder loaded without the outcome vocabulary.
	 */
	VocabularyUnavailable: "outcome_vocabulary_unavailable",
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
 * Whether a member satisfies a requested id: the member equals the id or begins with it and a dot.
 */
export function outcomeSatisfies(requested: string, member: string): boolean {
	return member === requested || member.startsWith(`${requested}.`)
}

/**
 * Whether a set of members satisfies one id of `requested`.
 */
export function outcomesSatisfy(
	requested: readonly string[],
	members: readonly Pick<OutcomeMembership, "outcome">[]
): boolean {
	return members.some((m) => requested.some((id) => outcomeSatisfies(id, m.outcome)))
}

/**
 * The `mw:id`s of every vocabulary member that satisfies one of `requested`.
 */
export function admittedOutcomeIDs(
	requested: readonly string[],
	vocabulary: readonly OutcomeVocabularyLike[]
): number[] {
	return vocabulary.filter((member) => requested.some((id) => outcomeSatisfies(id, member.name))).map((m) => m.id)
}

/**
 * Whether the request sets either outcome field.
 */
export function hasOutcomeOptions(options: OutcomeOptions | null | undefined): boolean {
	return !!options && (typeof options.outcomeHint === "string" || Array.isArray(options.outcomeFilter))
}

/**
 * Refuses an id outside the vocabulary and a hint that zero filter ids admit.
 *
 * @throws {OutcomeRequestError} With the refused id in the message.
 */
export function checkOutcomeOptions(options: OutcomeOptions, vocabulary: readonly OutcomeVocabularyLike[]): void {
	const known = new Set(vocabulary.map((m) => m.name))
	const ids = [...(options.outcomeFilter ?? []), ...(options.outcomeHint != null ? [options.outcomeHint] : [])]

	for (const id of ids) {
		if (!known.has(id)) {
			throw new OutcomeRequestError(
				OutcomeRefusal.UnknownOutcome,
				`"${id}" isn't an outcome kind. The vocabulary holds ${[...known].toSorted().join(", ")}.`
			)
		}
	}

	if (options.outcomeHint != null && options.outcomeFilter) {
		const hint = options.outcomeHint
		const admitted = options.outcomeFilter.some((id) => outcomeSatisfies(id, hint))

		if (!admitted) {
			throw new OutcomeRequestError(
				OutcomeRefusal.HintOutsideFilter,
				`The hint "${hint}" is outside the filter [${options.outcomeFilter.join(", ")}], so it can't be satisfied.`
			)
		}
	}
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
	const merged = new Map<string, OutcomeMembership>()

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
