/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Byte streams over a path, taking a {@linkcode PathBuilderLike} like the rest of `@mailwoman/core/fs`.
 *
 *   A stream is neither the synchronous surface nor the asynchronous one — `createReadStream` returns immediately and
 *   the work happens as the consumer pulls — so it sits in its own module rather than being duplicated across the
 *   pair. It is here for the same reason the readers are: `node:fs` is reached from `@mailwoman/core/fs` alone, and
 *   `packages/core/lib/fs/*` is the only place that reaches it.
 *
 *   These are thin. What they add is the path type and one import site, so a caller that already imports the readers
 *   does not reach past them for a stream.
 */

import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs"

import iconv from "iconv-lite"
import type { PathBuilderLike } from "path-ts"

/**
 * The runtime's own stream types, re-exported for the same reason the readers re-export theirs.
 */
export type { ReadStream, WriteStream } from "node:fs"
export { Duplex, Readable, Transform, Writable } from "node:stream"
export { finished, pipeline } from "node:stream/promises"

/**
 * Open a path for streaming reads.
 *
 * The stream holds a file descriptor until it ends or is destroyed. Bind it with `using` where the scope owns it, or
 * pipe it somewhere that closes it.
 */
export function openReadStream(path: PathBuilderLike, options?: Parameters<typeof createReadStream>[1]): ReadStream {
	return createReadStream(path.toString(), options)
}

/**
 * Open a path for streaming writes.
 *
 * Unlike the file writers in `./writers.ts`, this does NOT create the parent directory: a stream that fails on the
 * first chunk rather than at open time reports the missing directory somewhere the caller is no longer looking. Call
 * `makeDirectories` first where the parent may be absent.
 */
/**
 * Re-encode a byte stream from a legacy encoding into UTF-8, so a UTF-8 reader can consume it.
 *
 * The national registers this repository reads are not all UTF-8: Korea's address portal ships CP949, Japan's postcode
 * file Shift_JIS. `spliterator` splits UTF-8 bytes, so the decode happens upstream of the split rather than after it —
 * a line boundary found in CP949 bytes is not a line boundary.
 *
 * NOT `TextDecoder`, AND THE DIFFERENCE IS NOT SMALL. Node's WHATWG `euc-kr` implements EUC-KR proper (KS X 1001) and
 * not the UHC extension CP949 adds in lead bytes 0x81–0xA0. Of the 17,048 two-byte sequences Python's `cp949` accepts,
 * `TextDecoder('euc-kr')` reads 8,824 differently: 6,475 become U+FFFD and 2,349 become a DIFFERENT character with no
 * error raised. `iconv-lite` disagrees with `cp949` on none of the 17,048.
 *
 * It is not a rare corner. One row in 48,000 of the Korean address register carries such a sequence — `더샾오피스텔`, bytes
 * `b4 f5 98 de bf c0 c7 c7 bd ba c5 da`, which `TextDecoder` reads as `더乍의퓰뵀�`.
 *
 * The decoder is STREAMING for the same reason a `TextDecoder` would need `{ stream: true }`: a multi-byte character
 * split across two chunks must be held until its tail arrives, where a per-chunk decode emits a replacement character
 * and corrupts the row. `iconv-lite`'s stream decoder holds that state, and `end()` flushes what is left.
 *
 * @category Files
 * @param encoding An `iconv-lite` label — `cp949`, `shift_jis`, `gbk`.
 */
export async function* decodeByteStream(
	source: AsyncIterable<Uint8Array>,
	encoding: string
): AsyncGenerator<Uint8Array> {
	const decoder = iconv.getDecoder(encoding)
	const encoder = new TextEncoder()

	for await (const chunk of source) {
		const text = decoder.write(Buffer.from(chunk))

		if (text) {
			yield encoder.encode(text)
		}
	}

	const tail = decoder.end()

	if (tail) {
		yield encoder.encode(tail)
	}
}

/**
 * Decode bytes already in memory from a legacy encoding, the one-shot sibling of {@link decodeByteStream}.
 *
 * Same reasoning, same reason not to reach for `TextDecoder`, and it lives here so a reader that finds one finds the
 * other. Use this when the whole file is a bounded size the publisher fixes; use the stream when it is not.
 *
 * @category Files
 * @param encoding An `iconv-lite` label — `cp949`, `cp932`, `gbk`.
 */
export function decodeBytes(bytes: Uint8Array, encoding: string): string {
	return iconv.decode(Buffer.from(bytes), encoding)
}

export function openWriteStream(path: PathBuilderLike, options?: Parameters<typeof createWriteStream>[1]): WriteStream {
	return createWriteStream(path.toString(), options)
}
