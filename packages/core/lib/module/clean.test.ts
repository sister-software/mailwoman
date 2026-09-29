/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { pathExists } from "#fs/readers"
import { temporaryDirectory } from "#fs/temporary"
import { makeDirectories, writeLocalTextFile } from "#fs/writers"
import { assertDirectoryIsUntracked, cleanDirectory, cleanFile } from "#module/clean"

describe("clean", () => {
	test("allows only declared generated roots and their descendants", async () => {
		await using scratch = await temporaryDirectory("mw-clean-guard-")
		const output = scratch.path("packages/core/out")

		expect(() => assertDirectoryIsUntracked(output, [output])).not.toThrow()
		expect(() => assertDirectoryIsUntracked(scratch.path("packages/core/out/generated"), [output])).not.toThrow()

		expect(() => assertDirectoryIsUntracked(scratch.path("packages/core/outside"), [output])).toThrow(
			/outside declared generated directories/u
		)

		expect(() => assertDirectoryIsUntracked(scratch.path("packages/core/lib"), [output])).toThrow(
			/outside declared generated directories/u
		)

		expect(() => assertDirectoryIsUntracked(scratch.path("packages"), [output])).toThrow(
			/outside declared generated directories/u
		)
	})

	test("dry-run validates without changing directories or files", async () => {
		await using scratch = await temporaryDirectory("mw-clean-dry-run-")
		const output = scratch.path("packages/core/out")
		const artifact = scratch.path("packages/core/out/stale.js")

		await makeDirectories(output)
		await writeLocalTextFile("stale", artifact)

		await cleanDirectory(output, { allowedRoots: [output], dryRun: true })
		await cleanFile(artifact, { allowedRoots: [output], dryRun: true })

		expect(await pathExists(artifact)).toBe(true)
	})

	test("cleans existing artifacts and creates an allowed missing directory", async () => {
		await using scratch = await temporaryDirectory("mw-clean-write-")
		const output = scratch.path("packages/core/out")
		const artifact = scratch.path("packages/core/out/stale.js")

		await makeDirectories(output)
		await writeLocalTextFile("stale", artifact)
		await cleanDirectory(output, { allowedRoots: [output] })

		expect(await pathExists(output)).toBe(true)
		expect(await pathExists(artifact)).toBe(false)

		const missing = scratch.path("packages/core/dist")

		await cleanDirectory(missing, { allowedRoots: [missing] })
		expect(await pathExists(missing)).toBe(true)

		const buildMetadata = scratch.path("packages/core/tsconfig.tsbuildinfo")

		await writeLocalTextFile("metadata", buildMetadata)
		await cleanFile(buildMetadata, { allowedRoots: [buildMetadata] })
		expect(await pathExists(buildMetadata)).toBe(false)
	})
})
