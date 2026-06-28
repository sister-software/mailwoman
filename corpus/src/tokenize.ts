/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tokenizer interface for alignment.
 *
 *   Two implementations live in the corpus package:
 *
 *   1. `whitespaceTokenizer()` (this file): pure-JS, depends on nothing. Splits a string into maximal
 *        runs of letters/digits/marks, dropping whitespace and standalone punctuation. Used as the
 *        default for in-container alignment tests and as a fallback when no SentencePiece model is
 *        available.
 *   2. `sentencePieceTokenizer(modelPath)` (Phase 1 task #11, deferred): wraps the SentencePiece model
 *        trained on the corpus. Same interface, different splits. Locked against the corpus version
 *        (`tokenizer-v0.1.0` ships with `corpus-v0.1.0`).
 *
 *   The interface is intentionally minimal — only what alignment needs. Each token comes back with
 *   its (start, end) character offsets so BIO labels can be assigned by span overlap with component
 *   spans, independent of how the tokenizer chose its splits.
 */

/** A token with its character span in the source string. */
export interface TokenSpan {
	/** The token text, possibly normalized (case unchanged here; tokenizers may differ). */
	text: string

	/** Inclusive start offset (UTF-16 code-unit index) in the source string. */
	start: number

	/** Exclusive end offset in the source string. `text === source.slice(start, end)`. */
	end: number
}

/** A tokenizer that maps a string to a sequence of `TokenSpan`s. */
export interface Tokenizer {
	tokenize(text: string): readonly TokenSpan[]
}

/**
 * Whitespace + punctuation tokenizer (pure JS).
 *
 * Tokens are maximal runs of unicode word characters (`\p{L}` letters, `\p{N}` digits, `\p{M}` marks, plus `'`, `-`,
 * `_`). Everything else — whitespace, punctuation, symbols — is treated as a separator and **not** emitted as a token.
 * The resulting spans cover the original string only on token regions; in-between regions belong to no token.
 *
 * This is intentionally lossy at the edges (alignment can still label every meaningful span). A future SentencePiece
 * tokenizer will preserve all bytes via byte-fallback.
 */
export function whitespaceTokenizer(): Tokenizer {
	// Maximal runs of letters/digits/marks plus the joiners common to addresses
	// (apostrophe, hyphen, underscore). Comma/space/period etc. are not in the set.
	const tokenRe = /[\p{L}\p{N}\p{M}'_-]+/gu

	return {
		tokenize(text: string): readonly TokenSpan[] {
			const out: TokenSpan[] = []
			tokenRe.lastIndex = 0
			let m: RegExpExecArray | null

			while ((m = tokenRe.exec(text))) {
				out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
			}

			return out
		},
	}
}
