// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A streaming Deflate64 inflater over the committed `wasm/deflate64.wasm`.
 *
 *   Deflate64 is zip compression method 9. Node's zlib has no Deflate64 and yauzl refuses the method, so
 *   {@link inflateDeflate64} decompresses a member's raw bytes through `crates/deflate64-wasm`, an adapter over
 *   the MIT-licensed `deflate64` crate. Each call instantiates its own module, stages one compressed chunk at
 *   a time in linear memory, and copies each filled output span out before reusing it. The decoder keeps a
 *   128 KiB window, so memory stays fixed whatever the member's size.
 */

import { readLocalBuffer } from "#fs/readers"

/**
 * The location of the committed `wasm/deflate64.wasm`, resolved from this module.
 *
 * The same relative path holds from `lib/fs/` in the repository and from `out/fs/` in a tarball.
 */
export function deflate64WASMURL(): URL {
	return new URL("../../wasm/deflate64.wasm", import.meta.url)
}

/**
 * A compiled WebAssembly module.
 *
 * The type is opaque because the Node type preset omits the DOM library that declares `WebAssembly`.
 */
interface CompiledModule {
	readonly [Symbol.toStringTag]: string
}

/**
 * The C ABI that `crates/deflate64-wasm` exports.
 */
interface Deflate64Exports {
	memory: { readonly buffer: ArrayBuffer }
	d64_alloc(len: number): number
	d64_dealloc(ptr: number, len: number): void
	d64_new(): number
	d64_free(decoder: number): void
	d64_inflate(decoder: number, input: number, inputLength: number, output: number, outputLength: number): number
	d64_consumed(decoder: number): number
	d64_written(decoder: number): number
}

/**
 * The members of the global `WebAssembly` object this module calls.
 */
interface WebAssemblyAPI {
	compile(bytes: Uint8Array<ArrayBuffer>): Promise<CompiledModule>
	instantiate(module: CompiledModule, imports: object): Promise<{ exports: Deflate64Exports }>
}

declare const WebAssembly: WebAssemblyAPI

/**
 * The codes `d64_inflate` answers, equal to `deflate64_wasm::status`.
 */
const Status = {
	More: 0,
	Done: 1,
	DataError: -1,
} as const

/**
 * The output span each inflate call fills before its bytes are copied out.
 */
const OUTPUT_SPAN = 256 * 1024

let compiled: Promise<CompiledModule> | null = null

function compiledModule(): Promise<CompiledModule> {
	compiled ??= readLocalBuffer(deflate64WASMURL()).then((bytes) => WebAssembly.compile(new Uint8Array(bytes)))

	return compiled
}

/**
 * A staging span in linear memory, kept while it is large enough and replaced when a chunk outgrows it.
 */
class Staging {
	ptr = 0
	len = 0
	readonly #exports: Deflate64Exports

	constructor(exports: Deflate64Exports) {
		this.#exports = exports
	}

	reserve(len: number): number {
		if (len > this.len) {
			this.release()
			this.ptr = this.#exports.d64_alloc(len)
			this.len = len
		}

		return this.ptr
	}

	release(): void {
		if (this.len) {
			this.#exports.d64_dealloc(this.ptr, this.len)
		}

		this.len = 0
	}
}

/**
 * Inflate a raw Deflate64 stream.
 *
 * A method 9 zip member read with yauzl's `decompress: false` is such a stream.
 * Each yielded chunk is a fresh copy the consumer may keep.
 *
 * A consumer that stops early ends the source's iteration.
 * The decoder's memory is released on every exit.
 *
 * @category Files
 * @throws When the bytes are not a valid Deflate64 stream, or when the source ends
 * before the stream's final block.
 */
export async function* inflateDeflate64(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
	const { exports } = await WebAssembly.instantiate(await compiledModule(), {})
	const decoder = exports.d64_new()
	const input = new Staging(exports)
	const output = new Staging(exports)
	const outputPtr = output.reserve(OUTPUT_SPAN)
	let consumedTotal = 0

	try {
		for await (const chunk of source) {
			const inputPtr = input.reserve(chunk.byteLength)

			// `memory.buffer` is re-read after every allocation, because growth detaches the previous buffer.
			new Uint8Array(exports.memory.buffer, inputPtr, chunk.byteLength).set(chunk)

			let offset = 0

			for (;;) {
				const status = exports.d64_inflate(
					decoder,
					inputPtr + offset,
					chunk.byteLength - offset,
					outputPtr,
					OUTPUT_SPAN
				)

				const consumed = exports.d64_consumed(decoder)
				const written = exports.d64_written(decoder)

				offset += consumed
				consumedTotal += consumed

				if (written) {
					yield new Uint8Array(exports.memory.buffer, outputPtr, written).slice()
				}

				if (status === Status.DataError) {
					throw new Error(`Deflate64 stream is invalid near compressed byte ${consumedTotal}`)
				}

				if (status === Status.Done) return

				// The output span had room and the chunk is spent, so the decoder needs the next chunk.
				if (offset >= chunk.byteLength && written < OUTPUT_SPAN) break

				// A call that consumes zero bytes and writes zero bytes would repeat forever on the same arguments.
				if (!consumed && !written) {
					throw new Error(`Deflate64 decoder stalled at compressed byte ${consumedTotal}`)
				}
			}
		}

		throw new Error(`Deflate64 stream ended after ${consumedTotal} compressed bytes, before its final block`)
	} finally {
		input.release()
		output.release()
		exports.d64_free(decoder)
	}
}
