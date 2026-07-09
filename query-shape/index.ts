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
 *   See `docs/articles/plan/reference/QUERY_SHAPE.md` for the design rationale and
 *   `docs/articles/plan/reference/STAGES.md` for how this fits into the runtime pipeline.
 */

export { classifyCodepoint, classifyToken, foldInputClass } from "./character-class.ts"
export { computeQueryShape } from "./compute.ts"
export { detectKnownFormats } from "./known-formats.ts"
export { detectRegionAbbreviations } from "./region-abbreviations.ts"
export { segment } from "./segmentation.ts"
export type {
	CharacterClass,
	ComputeQueryShapeOpts,
	KnownFormat,
	KnownFormatHit,
	NormalizedInputLite,
	QueryShape,
	RegionAbbreviationHit,
	Segment,
	SegmentSeparator,
	SpanRange,
	TokenCharacterClass,
	TokenClass,
	WhitespacePattern,
} from "./types.ts"
