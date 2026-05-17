/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Classification } from "@mailwoman/core/classification"
import type { TokenContext } from "@mailwoman/core/tokenization"

export type SolverContext = Pick<TokenContext, "solutions">

export interface Solver {
	solve(context: SolverContext): void
}

export type SolverConstructor = new () => Solver

export interface FilterRelation {
	object: Classification
	direction: FilterRelationDirection
	subject: Classification
}

export type FilterRelationDirection = "precedes" | "follows"

export type FilterRelationRule = [
	// ---
	object: Classification,
	relation: FilterRelationDirection,
	subject: Classification,
]
