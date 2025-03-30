// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { Classification } from "mailwoman/core/classification"
import type { TokenContext } from "mailwoman/core/tokenization"

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
