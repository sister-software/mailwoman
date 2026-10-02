/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The incremental digest the runner records in `manifest.json`.
 */

import { createHash, type Hash } from "@mailwoman/core/hash"

/**
 * A digest built from chunks rather than from one value.
 *
 * `@mailwoman/core/hash` covers one-shot digests with `sha256Hex` and whole-file digests with `sha256File`.
 * The runner needs neither, because it hashes each jsonl line as it streams past
 * and would otherwise read the file a second time for the manifest checksum.
 */
export interface StreamingHasher {
	update(chunk: string | Uint8Array): void
	digest(): string
}

/**
 * A SHA-256 {@linkcode StreamingHasher} returning a hex digest.
 *
 * `digest()` is idempotent and `update()` after it throws, so a caller cannot
 * extend a digest it has already recorded.
 */
export function streamingSha256(): StreamingHasher {
	const h: Hash = createHash("sha256")
	let finalized = false
	let digestHex = ""

	return {
		update(chunk) {
			if (finalized) throw new Error("streamingSha256: update() called after digest()")

			h.update(chunk)
		},
		digest() {
			if (!finalized) {
				digestHex = h.digest("hex")
				finalized = true
			}

			return digestHex
		},
	}
}
