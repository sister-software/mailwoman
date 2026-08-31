/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Re-exports of the canonical types from `@mailwoman/core/pipeline`.
 */
export type { LocaleHint, QueryIntentMarker, QueryKind, QueryKindResult } from "@mailwoman/core/pipeline"
export { QueryIntentCode } from "@mailwoman/core/pipeline"

/**
 * The minimal input shapes consumed by `classifyKind` come from `@mailwoman/query-shape` — one declaration shared by
 * every Stage-2.x consumer. `QueryShapeLike` stays this package's public name for its narrow read-only view.
 */
export type { NormalizedInputLite, QueryShapeSegmentsView as QueryShapeLike } from "@mailwoman/query-shape"
