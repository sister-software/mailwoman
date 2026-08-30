/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   File and content hashing utilities.
 */

import { readFileChunksSync } from "@mailwoman/core/fs/readers-sync"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { createHash } from "@mailwoman/platform/crypto"

/**
 * Streaming SHA-256 of a file, hex-encoded.
 */
export async function sha256File(path: string): Promise<string> {
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
 * Streaming MD5 of a file, hex-encoded. MD5 (not SHA-256) is used for build-provenance fingerprints that follow an
 * existing convention — the HM Land Registry PPD snapshot ships an `.md5` sibling, and
 * `gazetteer-pipeline/admin/index.ts`'s build-log fingerprint is MD5 — so a shard/artifact header recording a source
 * checksum matches the surrounding provenance chain rather than mixing algorithms. Not a security primitive; only ever
 * used for accidental-corruption / drift detection.
 */
export async function md5File(path: string): Promise<string> {
	const hash = createHash("md5")

	for await (const chunk of openReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/**
 * MD5 of in-memory content, hex-encoded — the {@link md5File} counterpart for a string that never becomes a file. Same
 * provenance-only rationale, and the same non-security caveat: it exists so a query text, a manifest line or a config
 * blob can be fingerprinted with the SAME algorithm as the files recorded beside it in one `meta` table.
 */
/**
 * The MD5 of a file, read in chunks, SYNCHRONOUS.
 *
 * {@linkcode md5File} is the one to reach for anywhere else. This exists because the FST builder and its whole call
 * chain are synchronous by design (`buildFSTFromWOF` → `buildLocaleFSTs`), and making them async to stamp a checksum
 * would cascade through command callers and tests for one hash. Chunked rather than `readLocalBufferSync`, because the
 * source is a multi-gigabyte database.
 */
export function md5FileSync(path: string): string {
	const hash = createHash("md5")

	for (const chunk of readFileChunksSync(path)) {
		hash.update(chunk)
	}

	return hash.digest("hex")
}

export function md5Hex(data: string | NodeJS.ArrayBufferView): string {
	return createHash("md5").update(data).digest("hex")
}
