/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SentencePiece tokenizer wrapper with char-offset realignment.
 *
 *   `@sctg/sentencepiece-js` is a pure-JS port of the unigram SentencePiece algorithm and produces
 *   pieces + ids but NOT offsets. The TS layer reconstructs offsets by walking the input string
 *   alongside the emitted pieces; this gives us the `[start, end)` char ranges the BIO decoder
 *   needs to map labels back to substrings.
 *
 *   Offset reconstruction algorithm:
 *
 *   - SentencePiece prepends `▁` (U+2581) to the first piece of each word (and to the first piece of
 *       the input). Pieces without `▁` are continuations of the current word.
 *   - When a piece starts with `▁`, consume any whitespace from the input before counting it.
 *   - The piece's actual chars (the piece minus a leading `▁`) advance the input cursor by that many
 *       code units. SentencePiece operates on Unicode codepoints, but since addresses are almost
 *       entirely BMP characters, JS code-unit indexing is correct in practice. Surrogate- pair
 *       codepoints would need `Array.from(s).length` accounting; deferred until the parity test
 *       surfaces a real case.
 *   - Byte-fallback pieces (`<0xHH>`) are not handled here. The v0.1.0 corpus and golden set are
 *       Latin-script; the parity test will surface any unhandled cases.
 *
 *   The wrapper supports two load modes:
 *
 *   - `loadFromBase64(b64)` — for tests and Node usage where the model is read off disk and
 *       base64-encoded before being handed to the JS port.
 *   - `loadFromFile(path)` — convenience helper that does the read + b64 + load.
 */

import { SentencePieceProcessor } from "@sctg/sentencepiece-js"

/** SentencePiece's word-boundary marker (U+2581 LOWER ONE EIGHTH BLOCK). */
export const SPACE_SENTINEL = "▁"

/** A tokenized piece paired with its char-range in the original input. */
export interface TokenizedPiece {
	/** The piece exactly as the tokenizer emitted it (with `▁` preserved where present). */
	piece: string
	/** The vocab id for this piece. */
	id: number
	/** Inclusive start char offset in the original input. */
	start: number
	/** Exclusive end char offset in the original input. */
	end: number
}

export interface EncodeResult {
	pieces: TokenizedPiece[]
	ids: number[]
}

export class MailwomanTokenizer {
	private constructor(private readonly processor: SentencePieceProcessor) {}

	/** Load from a base64-encoded `tokenizer.model`. Use for in-memory / test setups. */
	static async loadFromBase64(b64: string): Promise<MailwomanTokenizer> {
		const processor = new SentencePieceProcessor()
		await processor.loadFromB64StringModel(b64)
		return new MailwomanTokenizer(processor)
	}

	/**
	 * Load from a path to a `tokenizer.model` file on disk. **Node-only** — the dynamic `node:fs`
	 * import keeps this method out of the static dependency graph so the rest of the tokenizer
	 * bundles cleanly for the browser. Calling it in a browser throws at runtime; use
	 * `loadFromBase64` (or the URL-fetching loaders in `@mailwoman/neural-web`) instead.
	 */
	static async loadFromFile(modelPath: string): Promise<MailwomanTokenizer> {
		const { readFile } = await import(/* webpackIgnore: true */ "node:fs/promises")
		const buf = await readFile(modelPath)
		return MailwomanTokenizer.loadFromBase64(buf.toString("base64"))
	}

	/**
	 * Tokenize `text` to pieces + ids + realigned char offsets.
	 *
	 * The returned `pieces[i].piece` matches what the Python `sp.EncodeAsPieces(text)[i]` returns,
	 * and `pieces[i].id` matches `sp.EncodeAsIds(text)[i]`. The offsets are reconstructed in TS — see
	 * file header for the algorithm.
	 */
	encode(text: string): EncodeResult {
		const pieces = this.processor.encodePieces(text)
		const ids = this.processor.encodeIds(text)

		const tokenized: TokenizedPiece[] = []
		let cursor = 0

		for (let i = 0; i < pieces.length; i++) {
			const piece = pieces[i]!
			const id = ids[i] ?? -1
			const hasSentinel = piece.startsWith(SPACE_SENTINEL)
			const literal = hasSentinel ? piece.slice(SPACE_SENTINEL.length) : piece

			if (hasSentinel) {
				while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++
			}

			const start = cursor
			cursor += literal.length
			const end = cursor

			tokenized.push({ piece, id, start, end })
		}

		return { pieces: tokenized, ids }
	}

	/** Decode a list of ids back to a string. Delegates to the underlying processor. */
	decode(ids: number[] | Int32Array): string {
		const arr = ids instanceof Int32Array ? ids : Int32Array.from(ids)
		return this.processor.decodeIds(arr) as string
	}
}
