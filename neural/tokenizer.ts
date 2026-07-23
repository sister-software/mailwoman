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
 *   - Byte-fallback pieces (`<0xHH>`) ARE handled: a run of one or more consecutive `<0xHH>` pieces (the vocab’s
 *       fallback for any character with no direct token — observed live on curly quotes “”’’, guillemets «», and
 *       braces {} even on Latin-script input, not just non-Latin scripts) is buffered and decoded as one UTF-8 byte
 *       sequence via `TextDecoder`, and the cursor advances by the DECODED string’s length — not by the literal
 *       `”<0xHH>”` placeholder’s length (6 chars for a single byte that represents 1 real character, or worse for a
 *       multi-byte codepoint split across several fallback pieces). Before this fix the cursor over-advanced on every
 *       byte-fallback piece, desyncing every subsequent piece’s offsets for the REST of the input — see
 *       `neural/test/tokenizer-byte-fallback.test.ts` for the repro and the fix-wave writeup
 *       (`.superpowers/sdd/task-9-audit-report.md`, paired-punctuation audit).
 *   - A byte-fallback run is split **per source character** at UTF-8 sequence boundaries (lead-byte scan): each
 *       character’s pieces carry that character’s own `[start, end)` span — the last piece of the character’s byte
 *       segment owns the real range (so `raw.slice(start, end)` recovers exactly that character), earlier pieces in
 *       the segment get a zero-width range at the character’s start (the same “own placeholder, zero contribution”
 *       idiom `groupPiecesIntoWords` uses for a bare ▁). This is what lets heterogeneous BIO tags inside one run
 *       survive decode: a run spanning multiple characters (東京都渋谷区 — every character its own 3-byte run
 *       segment) no longer collapses to one combined span on the run’s final piece, which used to silently absorb a
 *       B- tag boundary inside the run (the CJK residual resolved 2026-07-23; required before any non-Latin/CJK
 *       tokenizer ships). For a single-character run (curly quote, emoji) the split is a no-op — one segment,
 *       identical spans to the pre-split behavior.
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

/** A SentencePiece byte-fallback piece — the vocab's escape hatch for a character with no direct token. */
const BYTE_FALLBACK_RE = /^<0x([0-9A-Fa-f]{2})>$/

const utf8Decoder = new TextDecoder("utf-8", { fatal: false })

/**
 * Byte length of a UTF-8 sequence, from its lead byte. A continuation or invalid lead byte returns 1 so a malformed
 * byte forms its own one-byte segment (decoding to U+FFFD) instead of derailing the character split for the rest of the
 * run.
 */
function utf8SequenceLength(leadByte: number): number {
	if (leadByte < 0x80) return 1

	if (leadByte >= 0xc0 && leadByte < 0xe0) return 2

	if (leadByte >= 0xe0 && leadByte < 0xf0) return 3

	if (leadByte >= 0xf0 && leadByte < 0xf8) return 4

	return 1
}

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
	private readonly processor: SentencePieceProcessor

	private constructor(processor: SentencePieceProcessor) {
		this.processor = processor
	}

	/** Load from a base64-encoded `tokenizer.model`. Use for in-memory / test setups. */
	static async loadFromBase64(b64: string): Promise<MailwomanTokenizer> {
		const processor = new SentencePieceProcessor()
		await processor.loadFromB64StringModel(b64)

		return new MailwomanTokenizer(processor)
	}

	/**
	 * Load from a path to a `tokenizer.model` file on disk. **Node-only** — the dynamic `node:fs` import keeps this
	 * method out of the static dependency graph so the rest of the tokenizer bundles cleanly for the browser. Calling it
	 * in a browser throws at runtime; use `loadFromBase64` (or the URL-fetching loaders in `@mailwoman/neural-web`)
	 * instead.
	 */
	static async loadFromFile(modelPath: string): Promise<MailwomanTokenizer> {
		const { readFile } = await import(/* webpackIgnore: true */ "node:fs/promises")
		const buf = await readFile(modelPath)

		return MailwomanTokenizer.loadFromBase64(buf.toString("base64"))
	}

	/**
	 * Tokenize `text` to pieces + ids + realigned char offsets.
	 *
	 * The returned `pieces[i].piece` matches what the Python `sp.EncodeAsPieces(text)[i]` returns, and `pieces[i].id`
	 * matches `sp.EncodeAsIds(text)[i]`. The offsets are reconstructed in TS — see file header for the algorithm.
	 */
	encode(text: string): EncodeResult {
		const pieces = this.processor.encodePieces(text)
		const ids = this.processor.encodeIds(text)

		const tokenized: TokenizedPiece[] = []
		let cursor = 0

		// A run of consecutive byte-fallback pieces (see BYTE_FALLBACK_RE's doc comment) accumulates here until a
		// non-byte-fallback piece (or end of input) closes it — see flushByteRun.
		let byteRun: { pieces: string[]; ids: number[]; bytes: number[] } | null = null

		const flushByteRun = (): void => {
			if (!byteRun) return

			// Split the run at UTF-8 character boundaries (lead-byte scan) so each source character's pieces carry
			// that character's own span — a run spanning multiple characters must NOT collapse onto one combined
			// offset, or heterogeneous BIO tags inside the run get absorbed into a single span (see file header).
			let pieceIndex = 0

			for (let byteIndex = 0; byteIndex < byteRun.bytes.length;) {
				const segmentLength = Math.min(utf8SequenceLength(byteRun.bytes[byteIndex]!), byteRun.bytes.length - byteIndex)
				const decoded = utf8Decoder.decode(Uint8Array.from(byteRun.bytes.slice(byteIndex, byteIndex + segmentLength)))
				const start = cursor
				cursor += decoded.length
				const end = cursor

				for (let k = 0; k < segmentLength; k++) {
					const isLast = k === segmentLength - 1
					// The segment's LAST piece owns the character's real [start, end) span (so `raw.slice(start, end)`
					// recovers the character); earlier pieces get a zero-width range at the character's start — the
					// same "own placeholder, zero contribution" idiom groupPiecesIntoWords uses for a bare ▁.
					tokenized.push({
						piece: byteRun.pieces[pieceIndex]!,
						id: byteRun.ids[pieceIndex]!,
						start,
						end: isLast ? end : start,
					})
					pieceIndex++
				}

				byteIndex += segmentLength
			}

			byteRun = null
		}

		for (let i = 0; i < pieces.length; i++) {
			const piece = pieces[i]!
			const id = ids[i] ?? -1
			const hasSentinel = piece.startsWith(SPACE_SENTINEL)
			const literal = hasSentinel ? piece.slice(SPACE_SENTINEL.length) : piece
			const byteMatch = BYTE_FALLBACK_RE.exec(literal)

			if (byteMatch) {
				if (!byteRun) {
					if (hasSentinel) {
						while (cursor < text.length && /\s/.test(text[cursor]!)) {
							cursor++
						}
					}
					byteRun = { pieces: [], ids: [], bytes: [] }
				}

				byteRun.pieces.push(piece)
				byteRun.ids.push(id)
				byteRun.bytes.push(Number.parseInt(byteMatch[1]!, 16))
				continue
			}

			flushByteRun()

			if (hasSentinel) {
				while (cursor < text.length && /\s/.test(text[cursor]!)) {
					cursor++
				}
			}

			const start = cursor
			cursor += literal.length
			const end = cursor

			tokenized.push({ piece, id, start, end })
		}

		flushByteRun()

		return { pieces: tokenized, ids }
	}

	/** Decode a list of ids back to a string. Delegates to the underlying processor. */
	decode(ids: number[] | Int32Array): string {
		const arr = ids instanceof Int32Array ? ids : Int32Array.from(ids)

		return this.processor.decodeIds(arr) as string
	}
}
