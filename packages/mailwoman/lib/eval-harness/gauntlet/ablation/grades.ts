/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Ablation grades and the order in which gauntlet reports print them.
 */

/**
 * Grade for one deletion variant under the expectation model.
 *
 * The grades `held`, `degraded`, and `correctlyAbstained` pass.
 * The failing grades stay distinct because each one points at a different kind of bug.
 *
 * - `lost` means the case should resolve and did not.
 * - `overconfident` means the case should abstain and resolved anyway.
 * - `homonymTakeover` means the case should abstain and resolved because the
 *   remaining text matches another place.
 * - `coarser` means the result stayed on the ladder but at a coarser rung than expected.
 * - `wrong` means the result left the ladder.
 * - `substituted` means another value filled the deleted component's slot.
 * - `ungraded` means the undeleted case was itself off the ladder.
 */
export type AblationGrade =
	| "held"
	| "degraded"
	| "correctlyAbstained"
	| "lost"
	| "overconfident"
	| "homonymTakeover"
	| "coarser"
	| "wrong"
	| "substituted"
	| "ungraded"

/**
 * Every {@linkcode AblationGrade} in the order that reports print them.
 */
export const ABLATION_GRADES = [
	"held",
	"degraded",
	"correctlyAbstained",
	"lost",
	"overconfident",
	"homonymTakeover",
	"coarser",
	"wrong",
	"substituted",
	"ungraded",
] as const satisfies readonly AblationGrade[]

/**
 * Grades that count as passes.
 */
export const PASSING_GRADES: ReadonlySet<AblationGrade> = new Set<AblationGrade>([
	"held",
	"degraded",
	"correctlyAbstained",
])

/**
 * Returns a new histogram with every {@linkcode AblationGrade} at zero.
 *
 * Each call returns a fresh object so that cells never share one.
 */
export function emptyGrades(): Record<AblationGrade, number> {
	return {
		held: 0,
		degraded: 0,
		correctlyAbstained: 0,
		lost: 0,
		overconfident: 0,
		homonymTakeover: 0,
		coarser: 0,
		wrong: 0,
		substituted: 0,
		ungraded: 0,
	}
}
