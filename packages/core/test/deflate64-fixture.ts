/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The source bytes of `test/fixtures/zip/deflate64.zip`, a zip whose one member is compressed with method 9.
 *
 *   The archive was written by 7-Zip from these bytes saved as `source.bin`:
 *
 *   ```sh
 *   7z a -tzip -mm=Deflate64 -mx=9 deflate64.zip source.bin
 *   ```
 *
 *   The source has three parts, each aimed at a Deflate64 path that Deflate lacks or rarely takes. A random block
 *   recurs 48 KiB after its first copy, beyond Deflate's 32 KiB window and inside Deflate64's 64 KiB one. A long run
 *   of one repeated kilobyte invites matches longer than Deflate's 258-byte limit. The random block itself doesn't
 *   compress, so the encoder may store it.
 */

import { mulberry32 } from "#random"

/**
 * The member's name inside the fixture archive.
 */
export const DEFLATE64_FIXTURE_MEMBER = "source.bin"

const KIB = 1024

/**
 * The fixture member's uncompressed bytes, regenerated from a fixed seed.
 */
export function deflate64MemberBytes(): Uint8Array {
	const next = mulberry32(20_261_107)
	const random = new Uint8Array(40 * KIB)

	for (let index = 0; index < random.length; index += 1) {
		random[index] = Math.floor(next() * 256)
	}

	const encoder = new TextEncoder()
	const lines: string[] = []

	for (let line = 0; lines.join("\n").length < 8 * KIB; line += 1) {
		lines.push(`${line} Deflate64 fixture line ${Math.floor(next() * 1_000_000)}`)
	}

	const text = encoder.encode(lines.join("\n").slice(0, 8 * KIB))
	const pattern = encoder.encode(`${"0123456789abcdef".repeat(63)}0123456789abcdef`.slice(0, KIB))
	const parts = [random, text, random, ...Array.from({ length: 100 }, () => pattern)]
	const source = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
	let offset = 0

	for (const part of parts) {
		source.set(part, offset)
		offset += part.length
	}

	return source
}
