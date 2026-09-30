/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SentencePiece tokenizer wrapper over `@mailwoman/sentencepiece-wasm`.
 *
 *   The native offsets are UTF-8 byte positions and the decoder wants JS string (UTF-16 code-unit)
 *   ranges, so this layer converts once per encode and trims the whitespace a `▁`-prefixed piece
 *   consumes from its native span.
 */

import createSentencePiece, {
	type SentencePieceModule,
	type SentencePieceProcessor,
} from "@mailwoman/sentencepiece-wasm"
import type { PathBuilderLike } from "path-ts"

/**
 * SentencePiece's word-boundary marker (U+2581 lower one eighth block).
 */
export const SPACE_SENTINEL = "▁"

/**
 * The WASM module instantiates once per process.
 * Every tokenizer instance shares it.
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
 * Map every UTF-8 byte boundary of `text` to its UTF-16 code-unit offset.
 *
 * The returned array is indexed by byte offset.
 * A hole at a non-boundary index points to the containing character's start,
 * so a lookup cannot land outside the string.
 */
function buildByteToUTF16Map(text: string): number[] {
	// Walk once to size exactly rather than deriving a bound from the code-unit length.
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

	map.push(utf16)

	return map
}

/**
 * Matches any JS whitespace char.
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
	 * Load from a base64-encoded `tokenizer.model`.
	 *
	 * Use for in-memory / test / browser setups.
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
	 * Load from a path to a `tokenizer.model` file on disk, Node only.
	 *
	 * The dynamic `node:fs` import keeps this method out of the static dependency graph
	 * so the rest of the tokenizer bundles for the browser.
	 *
	 * A browser call throws at runtime, so use `loadFromBase64` or the URL-fetching
	 * loaders in `@mailwoman/neural/web/loader`.
	 */
	static async loadFromFile(modelPath: PathBuilderLike): Promise<MailwomanTokenizer> {
		const { readFile } = await import(/* webpackIgnore: true */ "node:fs/promises")
		const buf = await readFile(modelPath.toString())

		return MailwomanTokenizer.loadFromBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
	}

	/**
	 * Tokenize `text` to pieces, ids and native char offsets.
	 *
	 * The returned `pieces[i].piece` matches `sp.EncodeAsPieces(text)[i]` and `pieces[i].id`
	 * matches `sp.EncodeAsIDs(text)[i]`, while offsets come from SentencePiece's
	 * `SentencePieceText` proto converted to UTF-16 and whitespace-trimmed.
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

			// A `▁` piece's native span includes the consumed whitespace, so trim to the word start.
			// The loop is bounded by `end`, so a zero-width span stays put.
			while (start < end && WHITESPACE_RE.test(text[start]!)) {
				start++
			}

			tokenized.push({ piece, id: raw.ids[i]!, start, end })
		}

		return { pieces: tokenized, ids: raw.ids.slice() }
	}

	/**
	 * Decode a list of ids back to a string.
	 */
	decode(ids: number[] | Int32Array): string {
		const vector = new this.module.IntVector()

		try {
			for (const id of ids) {
				vector.push_back(id)
			}

			return this.processor.decodeIDs(vector)
		} finally {
			vector.delete()
		}
	}
}
