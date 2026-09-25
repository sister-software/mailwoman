import {
	constants,
	createZstdCompress,
	createZstdDecompress,
	zstdCompressSync,
	zstdDecompressSync,
	type ZstdCompress,
} from "node:zlib"

/**
 * The shape a `node:zlib` zstd transform presents: a duplex that is async-iterable
 * over bytes, which is exactly what a spliterator accepts as a source.
 */
type ZlibTransform = ZstdCompress

/**
 * Byte input accepted by the platform compression helpers.
 */
export type CompressionInput = string | Uint8Array

function inputBytes(input: CompressionInput): Uint8Array {
	return typeof input === "string" ? new TextEncoder().encode(input) : input
}

async function* byteChunks(source: AsyncIterable<CompressionInput>): AsyncGenerator<Uint8Array> {
	for await (const chunk of source) {
		yield inputBytes(chunk)
	}
}

function byteTransform(stream: CompressionStream | DecompressionStream): {
	readable: ReadableStream<Uint8Array>
	writable: WritableStream<Uint8Array>
} {
	// `pipeThrough` rejects the native transform: its readable side is `NonSharedUint8Array`
	// and its writable side is `BufferSource`, neither of which matches `ReadableStream<Uint8Array>`.
	// Wrapping the writer bridges both.
	// Keep the `new Uint8Array(chunk)` copy.
	// `Uint8Array<ArrayBufferLike>` may sit on a SharedArrayBuffer, which `BufferSource` excludes.
	// The copy produces a non-shared buffer.
	const writer = stream.writable.getWriter()

	return {
		readable: stream.readable,
		writable: new WritableStream<Uint8Array>({
			abort: (reason) => writer.abort(reason),
			close: () => writer.close(),
			write: (chunk) => writer.write(new Uint8Array(chunk)),
		}),
	}
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Compresses one bounded input with the runtime's native gzip stream.
 */
export async function gzip(input: CompressionInput): Promise<Uint8Array> {
	return collect(ReadableStream.from([inputBytes(input)]).pipeThrough(byteTransform(new CompressionStream("gzip"))))
}

/**
 * Decompresses one bounded gzip input with the runtime's native decompression stream.
 */
export async function gunzip(input: CompressionInput): Promise<Uint8Array> {
	return collect(ReadableStream.from([inputBytes(input)]).pipeThrough(byteTransform(new DecompressionStream("gzip"))))
}

/**
 * Lazily decompresses an asynchronous gzip byte source without buffering the complete input or output.
 */
export function gunzipChunks(source: AsyncIterable<Uint8Array | string>): ReadableStream<Uint8Array> {
	return ReadableStream.from(byteChunks(source)).pipeThrough(byteTransform(new DecompressionStream("gzip")))
}

/**
 * The CRC-32 and synchronous gzip `node:zlib` offers, for a checksum over a buffer
 * already in memory and for a response body compressed inside a request handler.
 *
 * Everything streamed goes through {@linkcode gunzipChunks}.
 */
export { crc32, gzipSync } from "node:zlib"

/**
 * Compresses one bounded input with zstd.
 *
 * `node:zlib` rather than a `CompressionStream`, because the web streams take a fixed enum
 * of formats and zstd is not among them — `new CompressionStream("zstd")` throws on Node 26.
 */
export function zstd(input: CompressionInput, level = 6): Uint8Array {
	return new Uint8Array(zstdCompressSync(inputBytes(input), { params: { [constants.ZSTD_c_compressionLevel]: level } }))
}

/**
 * Decompresses one bounded zstd input.
 */
export function unzstd(input: CompressionInput): Uint8Array {
	return new Uint8Array(zstdDecompressSync(inputBytes(input)))
}

/**
 * A zstd decompressor as a byte stream, for handing to a spliterator.
 *
 * Returned as a `node:stream` duplex rather than a `ReadableStream` because that is what
 * `AsyncDataResource` already accepts — its `AsyncChunkIterator` arm names "a Node `Readable`
 * (child-process stdout, a gunzip pipe)" explicitly, and a zlib transform is async-iterable over bytes.
 * Pipe a file into this and pass the result straight to `JSONSpliterator.fromAsync`;
 * no adapter belongs in between.
 *
 * This decompressor materializes no whole file: a corpus part file is tens of gigabytes decompressed.
 */
export function zstdDecompressor(): ZlibTransform {
	return createZstdDecompress()
}

/**
 * A zstd compressor as a byte stream, the counterpart of {@linkcode zstdDecompressor}.
 */
export function zstdCompressor(level = 6): ZlibTransform {
	return createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: level } })
}
