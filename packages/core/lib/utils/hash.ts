/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   File and content hashing utilities.
 */

import { createHash } from "node:crypto"

import { openReadStream } from "#fs/streams"

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

export function md5Hex(data: string | NodeJS.ArrayBufferView): string {
	return createHash("md5").update(data).digest("hex")
}

/**
 * The incremental hasher, for input that arrives in pieces — a row at a time, a chunk at a time. For a whole value,
 * {@linkcode sha256Hex} and {@linkcode md5Hex} say which digest in their name.
 */
export { createHash, type Hash } from "node:crypto"
