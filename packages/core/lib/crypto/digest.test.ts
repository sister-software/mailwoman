/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, it } from "vitest"

import { hexOf, sha256Bytes } from "#crypto/digest"

it("digests to the SHA-256 test vector and renders lowercase hex", async () => {
	expect(hexOf(await sha256Bytes(new TextEncoder().encode("abc")))).toBe(
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	)

	expect(hexOf(new Uint8Array([0, 15, 255]))).toBe("000fff")
})
