/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Minimal character-range descriptor used internally. Compatible with `@mailwoman/core`'s `Span` class by shape —
 * consumers holding a `Span` can pass it where `SpanRange` is expected.
 */
export interface SpanRange {
	start: number
	end: number
	body: string
}

/**
 * Per-token character classification.
 */
export type TokenCharacterClass = "digit" | "alpha" | "mixed" | "punct" | "cjk" | "cyrillic" | "arabic"

/**
 * Whole-input character class — folded from `TokenCharacterClass`.
 */
export type CharacterClass = "numeric" | "alpha" | "alphanumeric" | "cjk" | "cyrillic" | "arabic" | "mixed"

/**
 * An ISO 15924 script code.
 *
 * It stands beside `CharacterClass` rather than replacing it. The class answers what the decoder and the tokenizer ask
 * — is this run ideographic, is it digits — and folds `cjk` over three scripts to do it. The script answers which
 * writing system, which is a different question and the one a locale hint needs: `서울특별시` and `東京都` are the same
 * `CharacterClass` and are `Hang` and `Hani`.
 *
 * `Zyyy` (Common) and `Zzzz` (Unknown) are Unicode's own codes and are answers rather than failures. A digit is
 * genuinely script-neutral. a codepoint in a script this file carries no ranges for is genuinely unknown, and saying so
 * beats folding it into a script that happens to be nearby.
 */
export type ScriptCode = "Latn" | "Hani" | "Hira" | "Kana" | "Hang" | "Cyrl" | "Arab" | "Yiii" | "Zyyy" | "Zzzz"

/**
 * One script the input is written in, and how much of it that script writes.
 */
export interface ScriptShare {
	script: ScriptCode
	/**
	 * Proportion of the input's script-containing codepoints, so digits and punctuation are outside both halves of the
	 * fraction. Shares sum to 1 across the list, and the list is empty when nothing in the input names a script.
	 */
	share: number
}

/**
 * Known-format identifier. The set is intentionally small + universal.
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
 * Punctuation grammar separator between consecutive segments.
 */
export type SegmentSeparator = "comma" | "newline" | "tab" | "whitespace" | "japanese-style" | null

/**
 * Whitespace pattern of the whole input.
 */
export type WhitespacePattern = "single" | "double" | "tab" | "mixed" | "none"

export interface TokenClass {
	span: SpanRange
	class: TokenCharacterClass
	length: number
	/**
	 * The ISO 15924 script this token is written in. `Zyyy` for a token carrying no script-containing codepoint, such as
	 * a bare house number.
	 */
	script: ScriptCode
}

export interface Segment {
	span: SpanRange
	body: string
	/**
	 * Position in the segment list, 0-indexed.
	 */
	index: number
	/**
	 * The separator that preceded this segment, or `null` for the first segment.
	 */
	separator: SegmentSeparator
}

export interface KnownFormatHit {
	format: KnownFormat
	span: SpanRange
	/**
	 * 0..1. Ambiguous patterns (`fr_postcode`/`de_postcode` overlap with `us_zip`) score lower.
	 */
	confidence: number
}

/**
 * A detected region abbreviation (e.g., "DC", "NY", "CA"). Used by the locality soft prior to bias preceding place-name
 * tokens toward `B-locality`.
 */
export interface RegionAbbreviationHit {
	/**
	 * Character offset into the normalized input.
	 */
	start: number
	/**
	 * The abbreviation text (e.g., "DC", "NY").
	 */
	span: string
}

/**
 * Structural snapshot of an input string, computed once at the boundary between Stage 1 and Stage 2 of the runtime
 * pipeline. Microseconds-cheap. Consumed by stages 2, 2.5, 3 (optional), and 6 as additional context.
 *
 * Bitter-lesson-safe: recognizes universal structural patterns (character class, punctuation, postcode shape) rather
 * than place-specific knowledge.
 */
export interface QueryShape {
	characterClass: CharacterClass
	/**
	 * Every ISO 15924 script the input is written in, ranked by share of its script-containing codepoints.
	 *
	 * This is what `characterClass` cannot say. The class folds Kana, Han and Hangul to one `cjk` value, and answers
	 * `mixed` for an input carrying a non-Latin span beside a Latin one — so a Han venue inside a London address, and a
	 * Korean address against a Japanese one, are indistinguishable to a consumer reading the fold alone.
	 */
	scripts: ScriptShare[]
	tokenClasses: TokenClass[]
	segments: Segment[]
	knownFormats: KnownFormatHit[]
	/**
	 * Region abbreviation hits detected in the input. The locality soft prior uses these to bias preceding place-name
	 * tokens toward `B-locality` / `I-locality` during Viterbi decoding.
	 */
	regionAbbreviations: RegionAbbreviationHit[]
	totalLength: number
	whitespacePattern: WhitespacePattern
}

/**
 * Minimal normalized-input shape shared by the Stage 2–2.7 consumers — `computeQueryShape` here, plus
 * `@mailwoman/locale-hint`, `@mailwoman/kind-classifier`, and `@mailwoman/phrase-grouper`, which re-export it rather
 * than re-declaring. The full `NormalizedInput` from `@mailwoman/normalize` is structurally compatible — no import
 * required.
 */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/**
 * Read-only view of one known-format hit — the narrow subset of fields the downstream stages consume. `KnownFormatHit`
 * satisfies it structurally (its `SpanRange` carries `body` as well).
 *
 * The `(string & {})` union arms keep these views assignable from the dependency-free pipeline interface
 * (`@mailwoman/core/pipeline`'s `QueryShapeLite`, whose fields are plain strings) while the named union still drives
 * editor completion at literal comparison sites.
 */
export interface KnownFormatHitView {
	format: KnownFormat | (string & {})
	span: { start: number; end: number }
	confidence: number
}

/**
 * Narrow read-only view of a `QueryShape` for consumers that read only the format hits and the whole-input class —
 * `@mailwoman/locale-hint`'s input interface. The full `QueryShape` satisfies it structurally.
 */
export interface QueryShapeFormatsView {
	knownFormats: ReadonlyArray<KnownFormatHitView>
	characterClass?: CharacterClass | (string & {})
	/**
	 * Optional so a hand-built shape stays valid; `computeQueryShape` always supplies it.
	 */
	scripts?: ReadonlyArray<{ script: ScriptCode | (string & {}); share: number }>
	totalLength?: number
}

/**
 * Read-only view of one segment. `Segment` satisfies it structurally; `span` stays optional so hand-built shapes
 * without offsets remain valid.
 */
export interface SegmentView {
	body: string
	index: number
	span?: { start: number; end: number }
}

/**
 * `QueryShapeFormatsView` plus segmentation — `@mailwoman/kind-classifier`'s input interface.
 */
export interface QueryShapeSegmentsView extends QueryShapeFormatsView {
	segments?: ReadonlyArray<SegmentView>
}

/**
 * Read-only view of one token classification. `TokenClass` satisfies it structurally.
 */
export interface TokenClassView {
	span: { start: number; end: number; body: string }
	class: TokenCharacterClass | (string & {})
	length: number
	script?: ScriptCode | (string & {})
}

/**
 * `QueryShapeSegmentsView` plus per-token classes — `@mailwoman/phrase-grouper`'s input interface.
 */
export interface QueryShapeTokensView extends QueryShapeSegmentsView {
	tokenClasses?: ReadonlyArray<TokenClassView>
}

export interface ComputeQueryShapeOpts {
	/**
	 * Locale hint for segmentation grammar (default: comma-based Western).
	 */
	locale?: string
}
