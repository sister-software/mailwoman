/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The typed evidence union. The difference between the kinds is what each is allowed to do:
 *
 *   - `observation` — retrieved from an identified source at a recorded vintage. Has no score. A source either stated it or
 *     did not.
 *   - `relation` — structural compatibility between entities. It contains an assertion.
 *     It contains a score only when that assertion is `inferred`.
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
	 * The vintage the source recorded this at.
	 *
	 * `null` when the record does not include one — the gazetteer trace, for instance,
	 * identifies the row the source picked.
	 * It does not identify the extract's date.
	 * A `null` means the source did not record a date.
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
	score: number | null
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
	score?: number | null
}

export function observation(source: string, vintage: string | null, value: unknown): Observation {
	return { kind: "observation", source, vintage, value }
}

/**
 * A relation stated by a source is authoritative and has no score.
 * One we concluded is inferred and may.
 *
 * A score on an authoritative relation is refused, because it means the link
 * was concluded rather than stated.
 */
export function relation(input: RelationInput): Relation {
	if (input.assertion === Assertion.Authoritative && input.score != null) {
		throw new Error(
			`authoritative relation cannot carry a score (${input.relationship} from ${input.source}): a score means the link was concluded, not stated`
		)
	}

	return {
		kind: "relation",
		source: input.source,
		vintage: input.vintage,
		relationship: input.relationship,
		assertion: input.assertion,
		score: input.score ?? null,
	}
}

export function prior(source: string, label: string, weight: number): Prior {
	return { kind: "prior", source, label, weight }
}
