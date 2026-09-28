/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Type surface of the committed `sentencepiece.mjs` artifact, google/sentencepiece **v0.2.2**
 *   compiled to wasm with the native-offsets embind wrapper (`binding.cpp`). Rebuilt only by
 *   `build.sh`. Bump the tag there and note it here.
 */

/**
 * One encode result.
 *
 * `begins` and `ends` are UTF-8 byte offsets into the encoded input.
 * The upstream invariant is `utf8(text).slice(begins[i], ends[i])` equals the piece's surface.
 *
 * Consecutive pieces also occupy contiguous byte ranges.
 * The TS tokenizer layer owns byte→UTF-16 conversion.
 */
export interface EncodeWithOffsetsResult {
	pieces: string[]
	ids: number[]
	begins: number[]
	ends: number[]
	/**
	 * Present instead of the arrays when encoding failed (errors cross the boundary as values).
	 */
	error?: string
}

/**
 * The bound processor.
 *
 * Construct via the module factory, then `loadFromSerializedProto` once.
 */
export declare class SentencePieceProcessor {
	constructor()
	/**
	 * Load a `tokenizer.model` from its serialized-proto bytes.
	 *
	 * Takes serialized model bytes as a `Uint8Array`.
	 * Embind marshals JS strings to `std::string` as UTF-8, corrupting arbitrary binary bytes.
	 *
	 * Returns `""` on success, the sentencepiece status message on failure.
	 */
	loadFromSerializedProto(serialized: Uint8Array): string
	encodeWithOffsets(text: string): EncodeWithOffsetsResult
	decodeIDs(ids: IntVector): string
	/**
	 * Embind object lifetime.
	 *
	 * The processor owns wasm-heap memory, so call `delete()` when done.
	 * Long-lived singletons in practice never do.
	 */
	delete(): void
}

/**
 * Embind-registered `std::vector<int>`.
 *
 * Build with `module.IntVector` and add ids with `push_back`.
 * Call `delete()` after use.
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
 * The emscripten modularize factory.
 * It resolves once the embedded wasm is instantiated.
 */
declare function createSentencePiece(): Promise<SentencePieceModule>

export default createSentencePiece
