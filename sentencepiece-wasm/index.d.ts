/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Type surface of the committed `sentencepiece.mjs` artifact — google/sentencepiece **v0.2.2**
 *   compiled to WASM with the native-offsets embind wrapper (`binding.cpp`, task #26). Rebuilt only
 *   by `build.sh`; bump the tag there and note it here.
 */

/**
 * One encode result. `begins`/`ends` are UTF-8 BYTE offsets into the encoded input with the upstream invariant
 * `utf8(text).slice(begins[i], ends[i])` = the piece's surface, and contiguity between consecutive pieces. The TS
 * tokenizer layer owns byte→UTF-16 conversion.
 */
export interface EncodeWithOffsetsResult {
	pieces: string[]
	ids: number[]
	begins: number[]
	ends: number[]
	/**
	 * Present INSTEAD of the arrays when encoding failed (errors cross the boundary as values).
	 */
	error?: string
}

/**
 * The bound processor. Construct via the module factory, then `loadFromSerializedProto` once.
 */
export declare class SentencePieceProcessor {
	constructor()
	/**
	 * Load a `tokenizer.model` from its serialized-proto bytes. Takes a `Uint8Array` — the binding deliberately does NOT
	 * accept a string (embind marshals JS strings to `std::string` as UTF-8, which corrupts arbitrary binary). Returns
	 * `""` on success, the sentencepiece status message on failure.
	 */
	loadFromSerializedProto(serialized: Uint8Array): string
	encodeWithOffsets(text: string): EncodeWithOffsetsResult
	decodeIds(ids: IntVector): string
	/**
	 * Embind object lifetime: the processor owns WASM-heap memory — call when done (long-lived singletons in practice
	 * never do).
	 */
	delete(): void
}

/**
 * Embind-registered `std::vector<int>` — build with `module.IntVector`, `push_back` ids, and `delete()` after use.
 */
export declare class IntVector {
	constructor()
	push_back(value: number): void
	size(): number
	get(index: number): number
	delete(): void
}

export interface SentencePieceModule {
	SentencePieceProcessor: typeof SentencePieceProcessor
	IntVector: typeof IntVector
}

/**
 * The emscripten MODULARIZE factory — resolves once the embedded WASM is instantiated.
 */
declare function createSentencePiece(): Promise<SentencePieceModule>

export default createSentencePiece
