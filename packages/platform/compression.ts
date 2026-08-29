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
	// Node's Web Stream declarations type the writable side as the wider `BufferSource`; a Uint8Array is always one.
	return stream as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
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
