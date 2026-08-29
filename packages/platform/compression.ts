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
	// `pipeThrough` rejects the native transform: its readable side is `NonSharedUint8Array` and its writable side is
	// `BufferSource`, neither of which matches `ReadableStream<Uint8Array>`. Wrapping the writer bridges both.
	// Keep the `new Uint8Array(chunk)` copy — `Uint8Array<ArrayBufferLike>` may sit on a SharedArrayBuffer, which
	// `BufferSource` excludes. The copy produces a non-shared buffer.
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
