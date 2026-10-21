/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker mints two identifiers. This module also defines the stored form of the secret identifier.
 */

import { toBase64URL } from "@mailwoman/core/crypto/base64url"
import { hexOf, sha256Bytes } from "@mailwoman/core/crypto/digest"

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length))
}

/**
 * `lic_` plus 22 URL-safe characters from 16 random bytes.
 *
 * The value is impractical to guess and short enough to read aloud to support.
 */
export function newLicenseID(): string {
	return `lic_${toBase64URL(randomBytes(16))}`
}

/**
 * `clm_` plus 22 URL-safe characters from 16 random bytes: the claim the CLI polls
 * while a declared token travels by email.
 */
export function newClaimID(): string {
	return `clm_${toBase64URL(randomBytes(16))}`
}

/**
 * `iss_` plus 22 URL-safe characters from 16 random bytes: the key of one issuance row,
 * and the idempotency key of the email that delivers it.
 */
export function newIssuanceID(): string {
	return `iss_${toBase64URL(randomBytes(16))}`
}

/**
 * `dl_` plus 22 URL-safe characters from 16 random bytes: the key of one granted download.
 */
export function newDownloadID(): string {
	return `dl_${toBase64URL(randomBytes(16))}`
}

/**
 * 32 random bytes, url-safe: the per-license capability the refresh route accepts,
 * shown once and stored by digest.
 */
export function newRefreshSecret(): string {
	return toBase64URL(randomBytes(32))
}

/**
 * The stored form of a refresh secret: the plaintext is shown once and compared by digest after.
 */
export async function secretDigest(text: string): Promise<string> {
	// Copy the bytes into a plain ArrayBuffer.
	// The digest API requires that buffer type.
	return hexOf(await sha256Bytes(new Uint8Array(new TextEncoder().encode(text))))
}

/**
 * Compare two hex digests in time that depends only on their length.
 *
 * Visit every byte and fold the verdict instead of returning early.
 * A wrong secret then takes the same comparison path as any other mismatch.
 */
export function secretDigestsMatch(stored: string, candidate: string): boolean {
	if (stored.length !== candidate.length) return false

	let difference = 0

	for (let index = 0; index < stored.length; index += 1) {
		difference |= stored.charCodeAt(index) ^ candidate.charCodeAt(index)
	}

	return difference === 0
}
