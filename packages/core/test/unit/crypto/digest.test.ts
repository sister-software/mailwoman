// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { hexOf, sha256Bytes } from "@mailwoman/core/crypto/digest"
import { expect, it } from "vitest"

it("digests to the SHA-256 test vector and renders lowercase hex", async () => {
	expect(hexOf(await sha256Bytes(new TextEncoder().encode("abc")))).toBe(
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	)

	expect(hexOf(new Uint8Array([0, 15, 255]))).toBe("000fff")
})
