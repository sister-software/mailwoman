import { gunzip, gunzipChunks, gzip } from "@mailwoman/core/fs/compression"
import { describe, expect, it } from "vitest"

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
	const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
	const joined = new Uint8Array(size)
	let offset = 0

	for (const chunk of chunks) {
		joined.set(chunk, offset)
		offset += chunk.byteLength
	}

	return joined
}

describe("platform compression", () => {
	it("round-trips a bounded input asynchronously", async () => {
		const compressed = await gzip("Rue du Test")
		const restored = await gunzip(compressed)

		expect(new TextDecoder().decode(restored)).toBe("Rue du Test")
	})

	it("decompresses a chunked source without requiring a Node stream", async () => {
		const compressed = await gzip("one\ntwo\nthree\n")

		async function* chunks(): AsyncGenerator<Uint8Array> {
			yield compressed.subarray(0, 7)
			yield compressed.subarray(7)
		}

		const restored = joinChunks(await Array.fromAsync(gunzipChunks(chunks())))

		expect(new TextDecoder().decode(restored)).toBe("one\ntwo\nthree\n")
	})
})
