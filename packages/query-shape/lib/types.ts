/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A character range and its text.
 * A `Span` from `@mailwoman/core` has a compatible shape.
 */
export interface SpanRange {
	start: number
	end: number
	body: string
}

/**
 * The character class of one token.
 */
export type TokenCharacterClass = "digit" | "alpha" | "mixed" | "punct" | "cjk" | "cyrillic" | "arabic"

/**
 * The character class of the whole input, folded from the token classes.
 */
export type CharacterClass = "numeric" | "alpha" | "alphanumeric" | "cjk" | "cyrillic" | "arabic" | "mixed"

/**
 * An ISO 15924 script code.
 *
 * `CharacterClass` merges Kana, Han and Hangul into `cjk`.
 * A script code keeps them apart, so `서울특별시` is `Hang` while `東京都` is `Hani`.
 *
 * `Zyyy` (Common) marks script-neutral characters such as digits.
 * `Zzzz` (Unknown) marks a codepoint in a script that the classifier has no ranges for.
 */
export type ScriptCode = "Latn" | "Hani" | "Hira" | "Kana" | "Hang" | "Cyrl" | "Arab" | "Yiii" | "Zyyy" | "Zzzz"

/**
 * One script in the input and its share of the input.
 */
export interface ScriptShare {
	script: ScriptCode
	/**
	 * The fraction of the input's script codepoints in this script.
	 *
	 * Digits and punctuation do not count.
	 * Shares sum to 1 across a non-empty list.
	 */
	share: number
}

/**
 * The identifier of a structural format such as a postcode or PO box.
 */
export type KnownFormat =
	| "us_zip"
	| "us_zip4"
	| "uk_postcode"
	| "fr_postcode"
	| "ca_postcode"
	| "de_postcode"
	| "jp_postcode"
	| "nl_postcode"
	| "cz_postcode"
	| "sk_postcode"
	| "se_postcode"
	| "gr_postcode"
	| "po_box"

/**
 * The separator between consecutive segments.
 */
export type SegmentSeparator = "comma" | "newline" | "tab" | "whitespace" | "japanese-style" | null

/**
 * The whitespace pattern of the whole input.
 */
export type WhitespacePattern = "single" | "double" | "tab" | "mixed" | "none"

/**
 * One token with its character class, length and script.
 */
export interface TokenClass {
	span: SpanRange
	class: TokenCharacterClass
	length: number
	/**
	 * The token's ISO 15924 script.
	 *
	 * A token without script codepoints, such as a house number, is `Zyyy`.
	 */
	script: ScriptCode
}

/**
 * One separator-delimited segment of the input.
 */
export interface Segment {
	span: SpanRange
	body: string
	/**
	 * The zero-based position in the segment list.
	 */
	index: number
	/**
	 * The separator that preceded this segment, or `null` for the first segment.
	 */
	separator: SegmentSeparator
}

/**
 * One span that matches a known format.
 */
export interface KnownFormatHit {
	format: KnownFormat
	span: SpanRange
	/**
	 * The confidence from 0 to 1.
	 * Ambiguous patterns, such as five digits, score lower.
	 */
	confidence: number
}

/**
 * A detected region abbreviation, such as "DC" or "NY".
 */
export interface RegionAbbreviationHit {
	/**
	 * The character offset into the normalized input.
	 */
	start: number
	/**
	 * The abbreviation text.
	 */
	span: string
}

/**
 * A structural summary of an input string, computed once per query in the runtime pipeline.
 *
 * The summary is cheap enough to compute on every keystroke.
 * It records only structural patterns, such as character class, punctuation
 * and postcode shape, and no place-specific knowledge.
 */
export interface QueryShape {
	characterClass: CharacterClass
	/**
	 * Every ISO 15924 script in the input, ranked by share.
	 *
	 * The scripts distinguish inputs that `characterClass` merges, such as Korean
	 * and Japanese text or a Han name inside a Latin address.
	 */
	scripts: ScriptShare[]
	tokenClasses: TokenClass[]
	segments: Segment[]
	knownFormats: KnownFormatHit[]
	/**
	 * The region abbreviations in the input.
	 *
	 * The locality prior uses them to bias the preceding place-name tokens toward
	 * `B-locality` and `I-locality` during Viterbi decoding.
	 */
	regionAbbreviations: RegionAbbreviationHit[]
	totalLength: number
	whitespacePattern: WhitespacePattern
}

/**
 * The normalized-input fields that `computeQueryShape` and several other packages read.
 *
 * `NormalizedInput` from `@mailwoman/normalize` has a compatible shape.
 */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/**
 * A read-only view of the known-format hit fields that later stages read.
 *
 * The `(string & {})` members let `QueryShapeLite` from `@mailwoman/core/pipeline`,
 * whose fields are plain strings, satisfy these views.
 * The named literals still give editor completion.
 */
export interface KnownFormatHitView {
	format: KnownFormat | (string & {})
	span: { start: number; end: number }
	confidence: number
}

/**
 * A read-only view of a `QueryShape` with the format hits and the whole-input class.
 * It is the input type of `@mailwoman/locale-hint`.
 */
export interface QueryShapeFormatsView {
	knownFormats: ReadonlyArray<KnownFormatHitView>
	characterClass?: CharacterClass | (string & {})
	/**
	 * The ranked scripts.
	 *
	 * `computeQueryShape` always sets them.
	 * The field is optional so that hand-built shapes stay valid.
	 */
	scripts?: ReadonlyArray<{ script: ScriptCode | (string & {}); share: number }>
	totalLength?: number
}

/**
 * A read-only view of one segment.
 *
 * The `span` field is optional so that hand-built shapes without offsets stay valid.
 */
export interface SegmentView {
	body: string
	index: number
	span?: { start: number; end: number }
}

/**
 * A {@link QueryShapeFormatsView} with segments.
 * It is the input type of `@mailwoman/kind-classifier`.
 */
export interface QueryShapeSegmentsView extends QueryShapeFormatsView {
	segments?: ReadonlyArray<SegmentView>
}

/**
 * A read-only view of one token classification.
 */
export interface TokenClassView {
	span: { start: number; end: number; body: string }
	class: TokenCharacterClass | (string & {})
	length: number
	script?: ScriptCode | (string & {})
}

/**
 * A {@link QueryShapeSegmentsView} with token classes.
 * It is the input type of `@mailwoman/phrase-grouper`.
 */
export interface QueryShapeTokensView extends QueryShapeSegmentsView {
	tokenClasses?: ReadonlyArray<TokenClassView>
}

/**
 * Options for `computeQueryShape`.
 */
export interface ComputeQueryShapeOpts {
	/**
	 * The locale that selects the segmentation rules.
	 * Without it, commas separate segments.
	 */
	locale?: string
}
