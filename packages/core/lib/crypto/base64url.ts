/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Base64url and UTF-8 on the web platform's own primitives, so the license key format has no `Buffer` in it and the
 *   same module runs under Node, a Cloudflare Worker and a browser.
 */

export function toBase64URL(bytes: Uint8Array<ArrayBuffer>): string {
	let binary = ""

	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}

	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

export function fromBase64URL(text: string): Uint8Array<ArrayBuffer> {
	const padded = text
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(text.length / 4) * 4, "=")
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)

	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}

	return bytes
}

export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(text)
}

export function utf8Text(bytes: Uint8Array<ArrayBuffer>): string {
	return new TextDecoder().decode(bytes)
}
