/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Why `@mailwoman/core` carries `iconv-lite` rather than calling `TextDecoder`, pinned so the dependency cannot be
 *   removed as redundant.
 *
 *   Node's WHATWG `euc-kr` implements EUC-KR proper (KS X 1001) and not the UHC extension CP949 adds in lead bytes
 *   0x81–0xA0. Measured over every two-byte sequence Python's `cp949` accepts, `TextDecoder('euc-kr')` reads 8,824 of
 *   17,048 differently — 6,475 as U+FFFD and 2,349 as a different character with nothing raised. `iconv-lite` matches on
 *   all 17,048.
 *
 *   It reached a real row: one address in 48,000 of the Korean register carries `더샾오피스텔`, POSCO's "The Sharp"
 *   officetel brand, and `TextDecoder` reads it as `더乍의퓰뵀`.
 */

import { decodeByteStream, decodeBytes } from "@mailwoman/core/fs/streams"
import { describe, expect, it } from "vitest"

/**
 * `더샾오피스텔` in CP949. The `98 de` pair is the UHC extension `샾`, which EUC-KR proper does not carry.
 */
const THE_SHARP = Uint8Array.from([0xb4, 0xf5, 0x98, 0xde, 0xbf, 0xc0, 0xc7, 0xc7, 0xbd, 0xba, 0xc5, 0xda])

/**
 * `서울특별시`, wholly inside KS X 1001 — the subset that misled the first check into reporting that Node could read CP949,
 * from one string that happened to avoid the extension.
 */
const SEOUL = Uint8Array.from([0xbc, 0xad, 0xbf, 0xef, 0xc6, 0xaf, 0xba, 0xb0, 0xbd, 0xc3])

describe("decodeBytes", () => {
	it("reads a UHC-extension syllable the builtin decoder cannot", () => {
		expect(decodeBytes(THE_SHARP, "cp949")).toBe("더샾오피스텔")
	})

	it("differs from TextDecoder on exactly that input, which is why the dependency is here", () => {
		expect(new TextDecoder("euc-kr").decode(THE_SHARP)).not.toBe("더샾오피스텔")
	})

	it("agrees with TextDecoder inside KS X 1001, which is why the gap was missed at first", () => {
		expect(decodeBytes(SEOUL, "cp949")).toBe("서울특별시")
		expect(new TextDecoder("euc-kr").decode(SEOUL)).toBe("서울특별시")
	})
})

describe("decodeByteStream", () => {
	it("holds a character split across two chunks", async () => {
		// The split lands between `98` and `de` — the two bytes of `샾`. A per-chunk decode emits a replacement character
		// here and corrupts the row; the stream decoder holds the lead until its trail arrives.
		async function* halves(): AsyncGenerator<Uint8Array> {
			yield THE_SHARP.slice(0, 3)
			yield THE_SHARP.slice(3)
		}

		expect(await readAll(decodeByteStream(halves(), "cp949"))).toBe("더샾오피스텔")
	})

	it("emits UTF-8 bytes, which is what the line splitters read", async () => {
		async function* once(): AsyncGenerator<Uint8Array> {
			yield THE_SHARP
		}

		const chunks = await Array.fromAsync(decodeByteStream(once(), "cp949"))

		expect(new TextDecoder().decode(concat(chunks))).toBe("더샾오피스텔")
	})
})

async function readAll(source: AsyncIterable<Uint8Array>): Promise<string> {
	return new TextDecoder().decode(concat(await Array.fromAsync(source)))
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
	const out = new Uint8Array(total)
	let offset = 0

	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.length
	}

	return out
}
