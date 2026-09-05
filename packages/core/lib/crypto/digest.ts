/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SHA-256 on `crypto.subtle` and the hex rendering of a byte string: the digest the license key id, the register and
 *   the license worker share. `@mailwoman/core/hash` keeps the synchronous `node:crypto` digests for files and build
 *   scripts; this module is the one a Worker or a browser can import.
 */

export async function sha256Bytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data))
}

export function hexOf(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
