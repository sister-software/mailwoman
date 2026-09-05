/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two identifiers the worker mints, and the stored form of the one that is a secret.
 */

import { toBase64URL } from "@mailwoman/core/crypto/base64url"
import { hexOf, sha256Bytes } from "@mailwoman/core/crypto/digest"

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length))
}

/**
 * `lic_` plus 22 url-safe characters: 16 random bytes, enough that a guess never lands, and short enough to read aloud
 * to support.
 */
export function newLicenseID(): string {
	return `lic_${toBase64URL(randomBytes(16))}`
}

/**
 * 32 random bytes, url-safe: the per-license capability the refresh route accepts, shown once and stored by digest.
 */
export function newRefreshSecret(): string {
	return toBase64URL(randomBytes(32))
}

/**
 * The stored form of a refresh secret: the plaintext is shown once and compared by digest after.
 */
export async function secretDigest(text: string): Promise<string> {
	// A copy, so the bytes sit on a plain ArrayBuffer, which is what the digest's signature admits.
	return hexOf(await sha256Bytes(new Uint8Array(new TextEncoder().encode(text))))
}

/**
 * Compare two hex digests in time that depends on their length alone: every byte is visited, and the verdict is folded
 * in rather than returned early, so a wrong secret cannot be told from a wronger one by the clock.
 */
export function secretDigestsMatch(stored: string, candidate: string): boolean {
	if (stored.length !== candidate.length) return false

	let difference = 0

	for (let index = 0; index < stored.length; index += 1) {
		difference |= stored.charCodeAt(index) ^ candidate.charCodeAt(index)
	}

	return difference === 0
}
