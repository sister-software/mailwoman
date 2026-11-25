// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   File and content hashing utilities.
 */

import { createHash, hash as oneShotHash } from "node:crypto"

import type { PathBuilderLike } from "path-ts"

import { openReadStream } from "#fs/streams"

/**
 * One file as a record lists it: its path, its size and its SHA-256,
 * the values a later reader checks it against.
 */
export interface RecordedFile {
	path: string
	bytes: number
	sha256: string
}

/**
 * The stream produces a file's SHA-256 hash in hexadecimal.
 */
export async function sha256File(path: PathBuilderLike): Promise<string> {
	const hash = createHash("sha256")

	for await (const chunk of openReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/**
 * SHA-256 of in-memory content, hex-encoded.
 */
export function sha256Hex(data: string | NodeJS.ArrayBufferView | string[]): string {
	const formattedData = Array.isArray(data) ? data.join("\n") : data

	return createHash("sha256").update(formattedData).digest("hex")
}

/**
 * SHA-256 of in-memory content as a Node `Buffer` of its 32 raw bytes, computed synchronously in one call.
 *
 * The one-shot digest skips the hasher object an incremental `createHash` builds.
 * On a short id it took 2.6 µs against 5.5 µs.
 *
 * A corpus build hashes every row's id for its split, so the difference adds
 * up over hundreds of millions of rows.
 *
 * `sha256Bytes` in `#crypto/digest` is the asynchronous WebCrypto form for code that also runs in a browser.
 */
export function sha256Buffer(data: string | NodeJS.ArrayBufferView): Buffer {
	return oneShotHash("sha256", data, "buffer")
}

/**
 * The stream produces a file's MD5 hash in hexadecimal.
 *
 * MD5 is used for build-provenance fingerprints that follow an existing convention.
 * The HM Land Registry PPD snapshot ships an `.md5` sibling.
 *
 * `gazetteer-pipeline/admin/index.ts`'s build-log fingerprint is MD5 — so an extract/artifact header
 * recording a source checksum matches the surrounding provenance chain rather than mixing algorithms.
 * Not a security primitive.
 * Only ever used for accidental-corruption / drift detection.
 */
export async function md5File(path: PathBuilderLike): Promise<string> {
	const hash = createHash("md5")

	for await (const chunk of openReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/**
 * MD5 of in-memory content, hex-encoded.
 *
 * The {@link md5File} counterpart for a string that never becomes a file.
 *
 * It follows the same provenance-only rationale.
 * The same non-security caveat applies.
 *
 * It exists so a query text, a manifest line or a config blob can be fingerprinted with
 * the same algorithm as the files recorded beside it in one `meta` table.
 */

export function md5Hex(data: string | NodeJS.ArrayBufferView): string {
	return createHash("md5").update(data).digest("hex")
}

/**
 * MD5 of in-memory content as its 16 raw bytes.
 *
 * The hex form doubles the width and a caller comparing fingerprints by value pays for parsing it back.
 * A fixed-capacity fingerprint table reads four 32-bit words straight out of this buffer.
 *
 * Same provenance-only rationale as {@link md5Hex}, and the same non-security caveat.
 */
export function md5Bytes(data: string | NodeJS.ArrayBufferView): Buffer {
	return createHash("md5").update(data).digest()
}

/**
 * The incremental hasher, for input that arrives in pieces — a row at a time, a chunk at a time.
 *
 * For a whole value, {@linkcode sha256Hex} and {@linkcode md5Hex} say which digest in their name.
 */
export { createHash, type Hash } from "node:crypto"
