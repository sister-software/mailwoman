/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decodes a generated artifact module's base64 text into bytes, on the platforms the readers run on.
 */

/**
 * Decodes standard base64 into a fresh `Uint8Array`.
 *
 * `atob` is a global in Node 16 and later and in every browser, so the decoder
 * needs no `Buffer` and no `node:` import.
 */
export function decodeBase64(text: string): Uint8Array {
	const binary = atob(text)
	const bytes = new Uint8Array(binary.length)

	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}

	return bytes
}
