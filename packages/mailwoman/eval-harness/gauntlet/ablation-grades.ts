/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The ablation grade vocabulary — the verdict classes every gauntlet report iterates in one order.
 */

/**
 * The verdict for one deletion variant under the expectation model.
 *
 * `held` / `degraded` / `correctlyAbstained` are PASSES; the rest are failures, kept as distinct classes because they
 * ask the operator for different things. `lost` is a recall bug, `overconfident` is a calibration bug, `coarser` is a
 * precision bug (it stayed on the ladder but gave up more than the surviving evidence justified), `wrong` is a
 * resolution bug (it left the ladder — a different place), `substituted` is a slot-hazard bug, and `homonymTakeover` is
 * arguably not a bug at all: the remaining text genuinely names a different place.
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
 * Every {@linkcode AblationGrade}, as data — the histogram-iteration order the reports print in.
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
 * The grades that count as the pipeline behaving correctly.
 */
export const PASSING_GRADES: ReadonlySet<AblationGrade> = new Set<AblationGrade>([
	"held",
	"degraded",
	"correctlyAbstained",
])
