/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The TypeScript loader for the Multilingual Token Framework's WebAssembly runtime.
 *
 *   The module's import has no side effects: the WASM fetch and instantiation happen in the caller.
 *   The caller obtains the WASM bytes or a compiled `WebAssembly.Module` (Workers supply the latter)
 *   and passes it to {@linkcode MTFRuntime.instantiate}.
 *   `MTF_WASM_URL` locates the committed binary beside this package.
 *   A loaded model's encode and decode methods are synchronous.
 */

/**
 * The location of the committed `wasm/mtf.wasm`, resolved from this module.
 *
 * The same relative path holds from `lib/` in the repository and from `out/` in a tarball.
 */
export const MTF_WASM_URL = new URL("../wasm/mtf.wasm", import.meta.url)

/**
 * A compiled `WebAssembly.Module`, as a Worker runtime supplies it.
 *
 * The type is opaque because the Node type preset omits the DOM library that declares
 * `WebAssembly`, and this package's declarations must type-check without it.
 */
export interface MTFCompiledModule {
	readonly [Symbol.toStringTag]: string
}

/**
 * The bytes or compiled module the runtime instantiates from.
 */
export type MTFWasmSource = MTFCompiledModule | ArrayBuffer | Uint8Array<ArrayBuffer>

/**
 * The members of the global `WebAssembly` object this loader calls.
 */
interface WebAssemblyAPI {
	// Bytes come first: an `ArrayBuffer` also satisfies the opaque module type.
	instantiate(
		bytes: ArrayBuffer | Uint8Array<ArrayBuffer>,
		imports: object
	): Promise<{ instance: { exports: MTFExports } }>
	instantiate(module: MTFCompiledModule, imports: object): Promise<{ exports: MTFExports }>
}

/**
 * The runtime's global, typed to the members above.
 *
 * Every JavaScript runtime this package targets defines it.
 */
declare const WebAssembly: WebAssemblyAPI

/**
 * The pieces of one encoded input.
 *
 * `begins[i]` and `ends[i]` are UTF-8 byte offsets into the input as `TextEncoder` encodes it.
 * A byte-fallback piece other than the last for its character has `begins[i] === ends[i]`.
 */
export interface MTFEncodeResult {
	ids: number[]
	pieces: string[]
	begins: number[]
	ends: number[]
}

/**
 * The C ABI that `crates/mtf-wasm` exports.
 */
interface MTFExports {
	memory: { readonly buffer: ArrayBuffer }
	mtf_alloc(len: number): number
	mtf_dealloc(ptr: number, len: number): void
	mtf_error_ptr(): number
	mtf_error_len(): number
	mtf_model_load(ptr: number, len: number): number
	mtf_model_free(handle: number): void
	mtf_vocab_size(handle: number): number
	mtf_encode(handle: number, ptr: number, len: number): number
	mtf_decode(handle: number, ids: number, count: number): number
	mtf_words_ptr(handle: number): number
	mtf_bytes_ptr(handle: number): number
}

/**
 * Words per piece in the encode output buffer: id, begin, end, piece offset, piece length.
 */
const PIECE_WORDS = 5

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/**
 * One instantiated WebAssembly runtime.
 *
 * A runtime may hold several loaded models at once.
 */
export class MTFRuntime {
	readonly #exports: MTFExports

	private constructor(exports: MTFExports) {
		this.#exports = exports
	}

	/**
	 * Instantiates the runtime from WASM bytes or a compiled module.
	 */
	static async instantiate(source: MTFWasmSource): Promise<MTFRuntime> {
		const instance =
			source instanceof ArrayBuffer || ArrayBuffer.isView(source)
				? (await WebAssembly.instantiate(source, {})).instance
				: await WebAssembly.instantiate(source, {})

		return new MTFRuntime(instance.exports)
	}

	/**
	 * Loads a serialized SentencePiece unigram model.
	 *
	 * @throws When the bytes are malformed or the model uses a feature the runtime does not implement.
	 */
	loadModel(bytes: Uint8Array): MTFModel {
		const handle = this.#withInput(bytes, (ptr, len) => this.#exports.mtf_model_load(ptr, len))

		if (handle === 0) throw new Error(`mtf: model failed to load: ${this.lastError()}`)

		return new MTFModel(this, this.#exports, handle)
	}

	/**
	 * Reads the message the last failed call recorded.
	 *
	 * @internal
	 */
	lastError(): string {
		const { mtf_error_ptr, mtf_error_len, memory } = this.#exports

		return decoder.decode(new Uint8Array(memory.buffer, mtf_error_ptr(), mtf_error_len()))
	}

	/**
	 * Copies `bytes` into WASM memory for the duration of `call`.
	 *
	 * @internal
	 */
	withInput<T>(bytes: Uint8Array, call: (ptr: number, len: number) => T): T {
		return this.#withInput(bytes, call)
	}

	#withInput<T>(bytes: Uint8Array, call: (ptr: number, len: number) => T): T {
		const { mtf_alloc, mtf_dealloc, memory } = this.#exports
		const ptr = mtf_alloc(bytes.byteLength)

		if (ptr === 0) throw new Error(`mtf: could not allocate ${bytes.byteLength} bytes`)

		try {
			new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes)

			return call(ptr, bytes.byteLength)
		} finally {
			mtf_dealloc(ptr, bytes.byteLength)
		}
	}
}

/**
 * A loaded model.
 *
 * Dispose it with `using` or {@linkcode MTFModel.dispose} to release its WASM memory.
 */
export class MTFModel implements Disposable {
	readonly #runtime: MTFRuntime
	readonly #exports: MTFExports
	#handle: number

	/**
	 * @internal Construct through {@linkcode MTFRuntime.loadModel}.
	 */
	constructor(runtime: MTFRuntime, exports: MTFExports, handle: number) {
		this.#runtime = runtime
		this.#exports = exports
		this.#handle = handle
	}

	#live(): number {
		if (this.#handle === 0) throw new Error("mtf: the model was disposed")

		return this.#handle
	}

	/**
	 * The number of vocabulary rows.
	 */
	get vocabSize(): number {
		return this.#exports.mtf_vocab_size(this.#live())
	}

	/**
	 * Encodes `text` into pieces with UTF-8 byte offsets.
	 */
	encode(text: string): MTFEncodeResult {
		const handle = this.#live()
		const { mtf_encode, mtf_words_ptr, mtf_bytes_ptr, memory } = this.#exports
		const count = this.#runtime.withInput(encoder.encode(text), (ptr, len) => mtf_encode(handle, ptr, len))

		if (count < 0) throw new Error(`mtf: encode failed: ${this.#runtime.lastError()}`)

		const words = new Uint32Array(memory.buffer, mtf_words_ptr(handle), count * PIECE_WORDS)
		const bytesPtr = mtf_bytes_ptr(handle)
		const result: MTFEncodeResult = { ids: [], pieces: [], begins: [], ends: [] }

		for (let i = 0; i < count; i++) {
			const w = i * PIECE_WORDS

			result.ids.push(words[w]!)
			result.begins.push(words[w + 1]!)
			result.ends.push(words[w + 2]!)
			result.pieces.push(decoder.decode(new Uint8Array(memory.buffer, bytesPtr + words[w + 3]!, words[w + 4]!)))
		}

		return result
	}

	/**
	 * Decodes vocabulary IDs into text.
	 *
	 * @throws On an ID outside the vocabulary.
	 */
	decode(ids: ArrayLike<number>): string {
		const handle = this.#live()
		const { mtf_decode, mtf_bytes_ptr, memory } = this.#exports
		const packed = new Uint32Array(ids.length)

		for (let i = 0; i < ids.length; i++) {
			const id = ids[i]!

			if (!Number.isInteger(id) || id < 0) throw new Error(`mtf: invalid id: ${id}`)

			packed[i] = id
		}

		const bytes = new Uint8Array(packed.buffer)
		const length = this.#runtime.withInput(bytes, (ptr) => mtf_decode(handle, ptr, packed.length))

		if (length < 0) throw new Error(`mtf: decode failed: ${this.#runtime.lastError()}`)

		return decoder.decode(new Uint8Array(memory.buffer, mtf_bytes_ptr(handle), length))
	}

	/**
	 * Releases the model's WASM memory.
	 * Later calls on this model throw.
	 */
	dispose(): void {
		if (this.#handle === 0) return

		this.#exports.mtf_model_free(this.#handle)
		this.#handle = 0
	}

	[Symbol.dispose](): void {
		this.dispose()
	}
}
