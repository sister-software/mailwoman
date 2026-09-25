/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Computes a `QueryShape`, the cheap structural description of an input string: character and script classes,
 *   per-token classes, separator-bounded segments, known-format hits and whitespace pattern.
 */

/**
 * Re-exports the codepoint, token and script classifiers that {@link computeQueryShape}
 * is built from, for callers that need one signal without a full shape.
 */
export {
	classifyCodepoint,
	classifyToken,
	classifyTokens,
	classifyTokenScript,
	foldInputClass,
	foldInputScripts,
	scriptForCodepoint,
	scriptForRange,
} from "#character-class"

/**
 * Re-exports the entry point that computes a {@link QueryShape} from an input string or normalized input.
 */
export { computeQueryShape } from "#compute"
/**
 * Re-exports known-format detection and the predicate that tells which format names are postcodes.
 */
export { detectKnownFormats, isPostcodeFormat } from "#known-formats"
/**
 * Re-exports region-abbreviation detection and the shape-only token test that
 * other packages reuse with a wider letter limit.
 */
export { detectRegionAbbreviations, isRegionAbbreviationToken } from "#region-abbreviations"
/**
 * Re-exports the options for {@link isRegionAbbreviationToken}.
 */
export type { RegionAbbreviationTokenOpts } from "#region-abbreviations"
/**
 * Re-exports the splitter that divides input into comma-, newline- and tab-separated segments.
 */
export { segment } from "#segmentation"

/**
 * Re-exports the query-shape data types, including the narrow `*View` interfaces
 * that let consumers depend on only the fields they read.
 */
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
	ScriptCode,
	ScriptShare,
	Segment,
	SegmentSeparator,
	SegmentView,
	SpanRange,
	TokenCharacterClass,
	TokenClass,
	TokenClassView,
	WhitespacePattern,
} from "#types"
