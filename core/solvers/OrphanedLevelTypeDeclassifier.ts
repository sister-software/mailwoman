// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { SolverContext } from "@mailwoman/core"

export class OrphanedLevelTypeDeclassifier {
	solve(context: SolverContext): void {
		context.solutions = context.solutions.filter((solution) => {
			const levelType = solution.filter("level_designator")

			if (levelType.length === 0) return true

			const level = solution.filter("level")

			if (level.length === 0) {
				solution.matches = solution.findWithout("level_designator")

				return solution.matches.length > 0
			}

			return true
		})
	}
}
