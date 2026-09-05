/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { fromBase64URL, toBase64URL, utf8Bytes, utf8Text } from "@mailwoman/core/crypto/base64url"
import { describe, expect, it } from "vitest"

describe("base64url", () => {
	it("agrees with Node's base64url on every byte value", () => {
		const bytes = new Uint8Array(256).map((_, index) => index)

		expect(toBase64URL(bytes)).toBe(Buffer.from(bytes).toString("base64url"))
		expect(fromBase64URL(toBase64URL(bytes))).toEqual(bytes)
	})

	it("carries no padding and no +/ characters", () => {
		for (const length of [1, 2, 3, 4, 5]) {
			const text = toBase64URL(new Uint8Array(length).fill(0xff))

			expect(text).not.toMatch(/[=+/]/u)
		}
	})

	it("round-trips UTF-8 text through bytes", () => {
		expect(utf8Text(utf8Bytes("Zürich — 東京"))).toBe("Zürich — 東京")
	})
})
