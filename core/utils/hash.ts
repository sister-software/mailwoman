/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   File/content hashing — the canonical home for the ~12 `sha256OfFile` clones the 2026-07-09
 *   dedupe survey found across the corpus fetch scripts.
 */

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

/** Streaming SHA-256 of a file, hex-encoded. */
export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256")

	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/** SHA-256 of in-memory content, hex-encoded. */
export function sha256Hex(data: string | NodeJS.ArrayBufferView): string {
	return createHash("sha256").update(data).digest("hex")
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

	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}
