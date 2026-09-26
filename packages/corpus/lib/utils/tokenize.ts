/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Tokenizer interface for alignment. Each token comes back with its (start, end) character offsets so
 * BIO labels can be assigned by span overlap with component spans, independent of how the tokenizer
 * chose its splits; the interface is deliberately minimal — only what alignment needs.
 */

/**
 * A token with its character span in the source string.
 */
export interface TokenSpan {
	/**
	 * The token text, possibly normalized; this tokenizer leaves case unchanged.
	 */
	text: string

	/**
	 * Inclusive start offset, a UTF-16 code-unit index into the source string.
	 */
	start: number

	/**
	 * Exclusive end offset, with `text === source.slice(start, end)`.
	 */
	end: number
}

/**
 * A tokenizer that maps a string to a sequence of `TokenSpan`s.
 */
export interface Tokenizer {
	tokenize(text: string): readonly TokenSpan[]
}

/**
 * Whitespace + punctuation tokenizer (pure JS).
 *
 * Tokens are maximal runs of unicode word characters (`\p{L}`, `\p{N}`, `\p{M}`, plus `'`, `-`, `_`);
 * everything else is a separator and is not emitted, so the spans cover only token regions.
 * The lossiness at the edges is intentional, because alignment can still label every meaningful span.
 */
export function whitespaceTokenizer(): Tokenizer {
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

/**
 * Han characters, the script CJK addresses are written in and the one the
 * whitespace tokenizer cannot split: a run like `三分场八队` is one "word" to `\p{L}+`,
 * so the aligner could give it one label and never two.
 */
const HAN = /\p{Script=Han}/u

/**
 * Whitespace tokenizer for Latin runs, one token per character for Han runs.
 *
 * The CJK sibling model is character-level (CharCNN), so a per-character token is the
 * unit it labels, while the Latin tail of a mixed row (`赵光三分场二十九队, Heilongjiang, China`)
 * keeps the word tokens the Latin aligner has always used.
 * Spans still come back as `[start, end)` offsets over the source string,
 * so the aligner's span-overlap rule needs no change.
 */
export function cjkAwareTokenizer(): Tokenizer {
	const base = whitespaceTokenizer()

	return {
		tokenize(text: string): readonly TokenSpan[] {
			const out: TokenSpan[] = []

			for (const token of base.tokenize(text)) {
				if (!HAN.test(token.text)) {
					out.push(token)

					continue
				}

				// A Han run may carry Latin letters or digits inside it (`3分场2队`);
				// those stay glued to their neighbours only if they are Han too, so every
				// code point of a Han-containing token becomes its own token.
				let offset = token.start

				for (const codePoint of token.text) {
					out.push({ text: codePoint, start: offset, end: offset + codePoint.length })
					offset += codePoint.length
				}
			}

			return out
		},
	}
}
