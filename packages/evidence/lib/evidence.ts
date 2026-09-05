/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The typed evidence union. The difference between the kinds is what each is ALLOWED to do:
 *
 *   - `observation` — retrieved from a named source at a named vintage. Carries no score; a source either said it or
 *     did not.
 *   - `relation` — structural compatibility between entities. Carries an assertion, and a score only when that
 *     assertion is `inferred`.
 *   - `prior` — moves probability. Can never, by itself, prove or exclude.
 *
 *   An `exclusion` — proof that a candidate is impossible — joins the union from `./coverage.ts` and has no constructor
 *   here: one is built only through `requireExclusionBasis`, because an exclusion built without a coverage check is
 *   the defect this package exists to prevent.
 */

import type { Exclusion } from "#coverage"
import { Assertion } from "#status"

export interface Observation {
	kind: "observation"
	source: string
	/**
	 * The vintage the source recorded this at. `null` when the record does not carry one — the gazetteer trace, for
	 * instance, names the row it picked and not the extract's date — and a `null` is the statement that it was not
	 * recorded, which a fabricated date could never be.
	 */
	vintage: string | null
	value: unknown
}

export interface Relation {
	kind: "relation"
	source: string
	vintage: string
	relationship: string
	assertion: Assertion
	score?: number
}

export interface Prior {
	kind: "prior"
	source: string
	label: string
	weight: number
}

export type Evidence = Observation | Exclusion | Relation | Prior

export interface RelationInput {
	source: string
	vintage: string
	relationship: string
	assertion: Assertion
	score?: number
}

export function observation(source: string, vintage: string | null, value: unknown): Observation {
	return { kind: "observation", source, vintage, value }
}

/**
 * A relation stated by a source is authoritative and carries no score; one we concluded is inferred and may. A score on
 * an authoritative relation is refused, because it means the link was concluded, not stated.
 */
export function relation(input: RelationInput): Relation {
	if (input.assertion === Assertion.Authoritative && input.score !== undefined) {
		throw new Error(
			`authoritative relation cannot carry a score (${input.relationship} from ${input.source}): a score means the link was concluded, not stated`
		)
	}

	const base = {
		kind: "relation" as const,
		source: input.source,
		vintage: input.vintage,
		relationship: input.relationship,
		assertion: input.assertion,
	}

	return input.score === undefined ? base : { ...base, score: input.score }
}

export function prior(source: string, label: string, weight: number): Prior {
	return { kind: "prior", source, label, weight }
}
