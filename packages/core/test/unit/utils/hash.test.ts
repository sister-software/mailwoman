/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { md5File, sha256File, sha256Hex } from "@mailwoman/core/hash"
import { describe, expect, it } from "vitest"

import { temporaryDirectory } from "#fs/temporary"
import { writeLocalTextFile } from "#fs/writers"

// echo -n "mailwoman" | sha256sum
const MAILWOMAN_SHA256 = "d2594f1b25603175987fe47a442c3426f65b4572d4b82c8623daeb7bcc8c630d"
// echo -n "mailwoman" | md5sum
const MAILWOMAN_MD5 = "240ae1ee977a03307dc995f66031d0c5"

describe("hash", () => {
	it("sha256Hex hashes a string", () => {
		expect(sha256Hex("mailwoman")).toBe(MAILWOMAN_SHA256)
	})

	it("sha256File streams a file to the same digest", async () => {
		await using scratch = await temporaryDirectory("hash-")
		const path = scratch.resolve("f.txt")
		await writeLocalTextFile("mailwoman", path)
		expect(await sha256File(path)).toBe(MAILWOMAN_SHA256)
	})

	it("md5File streams a file to the known MD5 digest", async () => {
		await using scratch = await temporaryDirectory("hash-")
		const path = scratch.resolve("f.txt")
		await writeLocalTextFile("mailwoman", path)
		expect(await md5File(path)).toBe(MAILWOMAN_MD5)
	})
})
