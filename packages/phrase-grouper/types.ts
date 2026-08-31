/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Re-exports of the canonical types from `@mailwoman/core/pipeline`.
 */
export type { LocaleHint, PhraseGrouper, PhraseKind, PhraseProposal } from "@mailwoman/core/pipeline"

/**
 * Re-export of the canonical `Section` type from `@mailwoman/core/types`. `Section = Span`.
 */
export type { Section } from "@mailwoman/core/types"

/**
 * The minimal input shapes consumed by `groupPhrases` come from `@mailwoman/query-shape` — one declaration shared by
 * every Stage-2.x consumer. `QueryShapeLike` stays this package's public name for its narrow read-only view.
 */
export type { NormalizedInputLite, QueryShapeTokensView as QueryShapeLike } from "@mailwoman/query-shape"

export interface GroupPhrasesOpts {
	/**
	 * Reserved for future tunables (e.g. confidence floor, per-kind biasing). Currently unused.
	 */
	confidenceFloor?: number
}
