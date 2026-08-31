/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/query-shape` — pure-function structural priors for the runtime pipeline.
 *
 *   Computes a `QueryShape` from an input string: character class, per-token class, punctuation-
 *   bounded segments, known-format regex hits, and whitespace pattern. Microseconds-cheap, no ML,
 *   no runtime dependencies.
 *
 *   See `docs/engineering/reference/QUERY_SHAPE.md` for the design rationale and
 *   `docs/engineering/reference/STAGES.md` for how this fits into the runtime pipeline.
 */

export { classifyCodepoint, classifyToken, foldInputClass } from "#character-class"
export { computeQueryShape } from "#compute"
export { detectKnownFormats } from "#known-formats"
export { detectRegionAbbreviations, isRegionAbbreviationToken } from "#region-abbreviations"
export type { RegionAbbreviationTokenOpts } from "#region-abbreviations"
export { segment } from "#segmentation"

export type {
	CharacterClass,
	ComputeQueryShapeOpts,
	KnownFormat,
	KnownFormatHit,
	KnownFormatHitView,
	NormalizedInputLite,
	QueryShape,
	QueryShapeFormatsView,
	QueryShapeSegmentsView,
	QueryShapeTokensView,
	RegionAbbreviationHit,
	Segment,
	SegmentSeparator,
	SegmentView,
	SpanRange,
	TokenCharacterClass,
	TokenClass,
	TokenClassView,
	WhitespacePattern,
} from "#types"
