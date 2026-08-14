/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { md5File, sha256File, sha256Hex } from "./hash.ts"

// echo -n "mailwoman" | sha256sum
const MAILWOMAN_SHA256 = "d2594f1b25603175987fe47a442c3426f65b4572d4b82c8623daeb7bcc8c630d"
// echo -n "mailwoman" | md5sum
const MAILWOMAN_MD5 = "240ae1ee977a03307dc995f66031d0c5"

describe("hash", () => {
	it("sha256Hex hashes a string", () => {
		expect(sha256Hex("mailwoman")).toBe(MAILWOMAN_SHA256)
	})

	it("sha256File streams a file to the same digest", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "hash-")), "f.txt")
		writeFileSync(path, "mailwoman")
		expect(await sha256File(path)).toBe(MAILWOMAN_SHA256)
	})

	it("md5File streams a file to the known MD5 digest", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "hash-")), "f.txt")
		writeFileSync(path, "mailwoman")
		expect(await md5File(path)).toBe(MAILWOMAN_MD5)
	})
})
