// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Solver, SolverContext } from "@mailwoman/core"

/**
 * This solver extends solutions with venues to ensure that they are no spans are left behind.
 */
export class VenueCaptureSolver implements Solver {
	solve(context: SolverContext) {
		for (const solution of context.solutions) {
			const matches = solution.filter("venue")

			if (matches.length === 0) continue

			for (const match of matches) {
				if (match.start === 0) continue
			}
		}
	}
}
