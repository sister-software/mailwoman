/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"
import { describe, expect, test } from "vitest"

import { syncArtifact } from "#host-assets"

describe("syncArtifact", () => {
	test("copies a same-length edit and skips identical bytes", async () => {
		await using scratch = await temporaryDirectory("sync-artifact-")
		const source = resolvePath(scratch.path, "source.js")
		const dest = resolvePath(scratch.path, "dest.js")

		await writeLocalTextFile("const LIMIT = 1", source)
		expect(await syncArtifact(source, dest, "test")).toBe(true)
		expect(await syncArtifact(source, dest, "test")).toBe(false)

		await writeLocalTextFile("const LIMIT = 2", source)
		expect(await syncArtifact(source, dest, "test")).toBe(true)
		expect(await readLocalTextFile(dest)).toBe("const LIMIT = 2")
	})
})
