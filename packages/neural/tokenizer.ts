/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SentencePiece tokenizer wrapper over `@mailwoman/sentencepiece-wasm` (google/sentencepiece
 *   v0.2.2 with the native-offsets binding — task #26).
 *
 *   History: the previous runtime (`@sctg/sentencepiece-js`, an emscripten build of an OLDER
 *   sentencepiece whose binding never exposed the offset-carrying proto API) forced this file to
 *   RECONSTRUCT char offsets by re-walking the input string alongside the emitted pieces — ~90
 *   lines of cursor arithmetic with two documented hazard classes (byte-fallback desync, fixed by
 *   hand; surrogate-pair accounting, deferred) and one undocumented one (normalizer-changed
 *   surfaces: a piece like `DŽ` for input `Ǆ` desyncs a literal-length cursor). SentencePiece
 *   itself has always known the answer: `Encode(text, &SentencePieceText)` yields per-piece
 *   `begin`/`end` BYTE offsets with the invariant `utf8(text).slice(begin, end) == surface` and
 *   contiguity between consecutive pieces — including the "zero-width except the last piece owns
 *   the character's span" behavior for byte-fallback runs that the old reconstruction implemented
 *   manually (verified byte-for-byte in the swap's parity battery, 1,066 fixture rows).
 *
 *   What this layer still owns:
 *
 *   - **Byte → UTF-16 conversion.** The native offsets are UTF-8 byte positions; the decoder wants
 *       JS string (UTF-16 code-unit) ranges. The conversion walks code points once per encode and
 *       is exact for non-BMP input (the old shim's deferred hazard, now covered by tests).
 *   - **Leading-whitespace trim.** A `▁`-prefixed piece's native span INCLUDES the whitespace the
 *       sentinel consumed (surface " Rock" for piece `▁Rock`); the decoder's contract has always
 *       been starts-at-the-word (`start` points at "R"). Trimming preserves the shipped decode
 *       byte-exactly, and collapses the bare-`▁` piece to the zero-width-after-space range the
 *       word grouper expects.
 *
 *   The wrapper supports two load modes:
 *
 *   - `loadFromBase64(b64)` — for tests and browser usage where the model arrives as bytes.
 *   - `loadFromFile(path)` — Node-only convenience (dynamic `node:fs` import keeps the browser
 *       bundle clean).
 */

import createSentencePiece, {
	type SentencePieceModule,
	type SentencePieceProcessor,
} from "@mailwoman/sentencepiece-wasm"

/**
 * SentencePiece's word-boundary marker (U+2581 LOWER ONE EIGHTH BLOCK).
 */
export const SPACE_SENTINEL = "▁"

/**
 * The WASM module instantiates once per process — every tokenizer instance shares it.
 */
let modulePromise: Promise<SentencePieceModule> | null = null

function loadModule(): Promise<SentencePieceModule> {
	modulePromise ??= createSentencePiece()

	return modulePromise
}

/**
 * A tokenized piece paired with its char-range in the original input.
 */
export interface TokenizedPiece {
	/**
	 * The piece exactly as the tokenizer emitted it (with `▁` preserved where present).
	 */
	piece: string
	/**
	 * The vocab id for this piece.
	 */
	id: number
	/**
	 * Inclusive start char offset in the original input.
	 */
	start: number
	/**
	 * Exclusive end char offset in the original input.
	 */
	end: number
}

export interface EncodeResult {
	pieces: TokenizedPiece[]
	ids: number[]
}

/**
 * Map every UTF-8 byte boundary of `text` to its UTF-16 code-unit offset. Returned as a plain array indexed by byte
 * offset (holes at non-boundary indexes are filled with the containing character's START so a defensive lookup can
 * never land outside the string) — exact for surrogate-pair (non-BMP) input, the old reconstruction's deferred hazard.
 */
function buildByteToUTF16Map(text: string): number[] {
	// utf8 length ≤ 3 × utf16 length is not a safe bound (4-byte sequences ↔ 2 code units = 2×);
	// walk once to size exactly.
	const map: number[] = []
	let utf16 = 0

	for (const cp of text) {
		const code = cp.codePointAt(0)!
		const byteLength = code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4

		for (let b = 0; b < byteLength; b++) {
			map.push(utf16)
		}

		utf16 += cp.length
	}

	// The end-of-string boundary.
	map.push(utf16)

	return map
}

/**
 * Matches any JS whitespace char — the same class the old reconstruction skipped when a `▁` piece opened a word.
 */
const WHITESPACE_RE = /\s/

export class MailwomanTokenizer {
	private readonly processor: SentencePieceProcessor
	private readonly module: SentencePieceModule

	private constructor(module: SentencePieceModule, processor: SentencePieceProcessor) {
		this.module = module
		this.processor = processor
	}

	private static async loadFromBytes(bytes: Uint8Array): Promise<MailwomanTokenizer> {
		const module = await loadModule()
		const processor = new module.SentencePieceProcessor()
		const error = processor.loadFromSerializedProto(bytes)

		if (error !== "") {
			processor.delete()
			throw new Error(`tokenizer.model failed to load: ${error}`)
		}

		return new MailwomanTokenizer(module, processor)
	}

	/**
	 * Load from a base64-encoded `tokenizer.model`. Use for in-memory / test / browser setups.
	 */
	static async loadFromBase64(b64: string): Promise<MailwomanTokenizer> {
		const binary = atob(b64)
		const bytes = new Uint8Array(binary.length)

		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i)
		}

		return MailwomanTokenizer.loadFromBytes(bytes)
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

		return MailwomanTokenizer.loadFromBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
	}

	/**
	 * Tokenize `text` to pieces + ids + native char offsets.
	 *
	 * The returned `pieces[i].piece` matches what the Python `sp.EncodeAsPieces(text)[i]` returns, and `pieces[i].id`
	 * matches `sp.EncodeAsIds(text)[i]`. Offsets come from SentencePiece's own `SentencePieceText` proto (byte
	 * positions), converted to UTF-16 and whitespace-trimmed — see the file header for the two conventions this layer
	 * owns.
	 */
	encode(text: string): EncodeResult {
		const raw = this.processor.encodeWithOffsets(text)

		if (raw.error !== undefined) {
			throw new Error(`tokenizer encode failed: ${raw.error}`)
		}

		const byteToUTF16 = buildByteToUTF16Map(text)
		const tokenized: TokenizedPiece[] = []

		for (let i = 0; i < raw.pieces.length; i++) {
			const piece = raw.pieces[i]!
			let start = byteToUTF16[raw.begins[i]!] ?? text.length
			const end = byteToUTF16[raw.ends[i]!] ?? text.length

			// A ▁ piece's native span includes the consumed whitespace — trim to the word start (the
			// decoder's contract; see header). Bounded by `end`, so zero-width spans stay put.
			while (start < end && WHITESPACE_RE.test(text[start]!)) {
				start++
			}

			tokenized.push({ piece, id: raw.ids[i]!, start, end })
		}

		return { pieces: tokenized, ids: raw.ids.slice() }
	}

	/**
	 * Decode a list of ids back to a string. Delegates to the underlying processor.
	 */
	decode(ids: number[] | Int32Array): string {
		const vector = new this.module.IntVector()

		try {
			for (const id of ids) {
				vector.push_back(id)
			}

			return this.processor.decodeIds(vector)
		} finally {
			vector.delete()
		}
	}
}
