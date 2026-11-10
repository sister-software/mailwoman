/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SentencePiece-model tokenizer over the `@mailwoman/mtf` WASM runtime.
 *
 *   The native offsets are UTF-8 byte positions and the decoder reads JS string (UTF-16 code-unit)
 *   ranges, so this layer converts once per encode and trims the whitespace a `▁`-prefixed piece
 *   consumes from its native span.
 */

import { memoizeResettable } from "@mailwoman/core/memoize"
import { MTFRuntime, mtfWASMURL, type MTFModel, type MTFWasmSource } from "@mailwoman/mtf"
import type { PathBuilderLike } from "path-ts"

/**
 * SentencePiece's word-boundary marker (U+2581 lower one eighth block).
 */
export const SPACE_SENTINEL = "▁"

/**
 * The WASM a host supplied through {@linkcode setTokenizerRuntimeSource},
 * or `null` to read {@linkcode mtfWASMURL}.
 */
let runtimeSource: MTFWasmSource | null = null

/**
 * Whether a tokenizer has started loading the runtime, after which the source is fixed.
 */
let runtimeStarted = false

/**
 * Reads the runtime's WASM bytes from where {@linkcode mtfWASMURL} points.
 *
 * A `file:` URL is read from disk, as in Node.
 * Any other URL is fetched, as in a browser bundle whose host serves the binary
 * at the URL the bundler resolved.
 */
async function readRuntimeWasm(): Promise<MTFWasmSource> {
	const url = mtfWASMURL()

	if (url.protocol === "file:") {
		const { readFile } = await import(/* webpackIgnore: true */ "node:fs/promises")

		return new Uint8Array(await readFile(url))
	}

	const response = await fetch(url)

	if (!response.ok) throw new Error(`tokenizer runtime ${url} answered ${response.status}`)

	return response.arrayBuffer()
}

/**
 * The WASM runtime instantiates once per process, and every tokenizer instance shares it.
 *
 * A failed read or instantiation is retried by the next tokenizer load, so a page
 * whose first fetch failed can still tokenize once the network answers.
 */
const instantiateRuntime = memoizeResettable(async () =>
	MTFRuntime.instantiate(runtimeSource ?? (await readRuntimeWasm()))
)

function loadRuntime(): Promise<MTFRuntime> {
	runtimeStarted = true

	return instantiateRuntime()
}

/**
 * Supply the WASM the tokenizer runtime instantiates from, in place of reading {@linkcode mtfWASMURL}.
 *
 * A Cloudflare Worker refuses to compile WASM from bytes at run time, so its entry imports
 * `mtf.wasm` as a bundled `WebAssembly.Module` and passes it here before the first tokenizer loads.
 * Every loader, including the browser's `loadFromBase64` path, then instantiates from it.
 *
 * The runtime instantiates from it when the first tokenizer loads.
 *
 * @throws When a source was already set, or a tokenizer already started loading the runtime.
 */
export function setTokenizerRuntimeSource(source: MTFWasmSource): void {
	if (runtimeSource || runtimeStarted) {
		throw new Error("the tokenizer runtime is already loading; set its source before the first tokenizer loads")
	}

	runtimeSource = source
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
	private readonly model: MTFModel

	private constructor(model: MTFModel) {
		this.model = model
	}

	private static async loadFromBytes(bytes: Uint8Array): Promise<MailwomanTokenizer> {
		const runtime = await loadRuntime()

		try {
			return new MailwomanTokenizer(runtime.loadModel(bytes))
		} catch (error) {
			throw new Error(`tokenizer.model failed to load: ${(error as Error).message}`, { cause: error })
		}
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
		const raw = this.model.encode(text)
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

		return { pieces: tokenized, ids: raw.ids }
	}

	/**
	 * Decode a list of ids back to a string.
	 */
	decode(ids: number[] | Int32Array): string {
		return this.model.decode(ids)
	}
}
