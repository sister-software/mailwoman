/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Classification, Solver, SolverContext } from "@mailwoman/core"

const LeadingArea = {
	Admin: new Set<Classification>(["locality", "region", "country"]),
	Netural: new Set<Classification>(["postcode"]),
} as const satisfies Record<string, ReadonlySet<Classification>>

/**
 * This solver removes leading area classifications that are not the last non-admin classification.
 */
export class LeadingAreaDeclassifier implements Solver {
	solve(context: SolverContext) {
		for (const solution of context.solutions) {
			// Track the last non-admin cursor position.
			let lastNonAdminCursorPosition = 0

			for (const { classification, span } of solution.matches) {
				if (LeadingArea.Admin.has(classification)) continue
				if (LeadingArea.Netural.has(classification)) continue

				lastNonAdminCursorPosition = span.end
			}

			solution.matches = solution.matches.filter(({ classification, span }) => {
				const isAdmin = LeadingArea.Admin.has(classification)

				// if (isAdmin && pair.span.end < lastNonAdminCursorPosition) return false
				return !(isAdmin && span.end < lastNonAdminCursorPosition)
			})
		}

		context.solutions.sort((a, b) => b.score - a.score)
		context.solutions.forEach((s) => s.matches.sort((a, b) => a.span.start - b.span.start))
	}
}
