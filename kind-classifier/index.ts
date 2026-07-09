/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/kind-classifier` — Stage 2.5 of the runtime pipeline.
 *
 *   Categorize inputs into one of seven `QueryKind`s by composing rule-based scorers over the
 *   QueryShape sub-system's output. Pure functions, no ML, no place-name dictionaries. Returns
 *   possibilities (alternatives) alongside the top pick so the coordinator can fall back when the
 *   winning kind isn't actionable.
 *
 *   See `docs/articles/plan/reference/STAGES.md` § Stage 2.5 for the contract.
 */

export { classifyKind, classifyKindSync } from "./classify.ts"
export {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
} from "./rules.ts"
export type { LocaleHint, NormalizedInputLite, QueryKind, QueryKindResult, QueryShapeLike } from "./types.ts"
