/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { findOperation } from "@mailwoman/release-kit"
import { describe, expect, test } from "vitest"

const cleanOperation = findOperation("release.clean")

if (!cleanOperation) throw new Error("release.clean is not registered")

async function fixture() {
	const scratch = await temporaryDirectory("mw-clean-operation-")

	await writeLocalJSONFile({ workspaces: ["packages/*"] }, scratch.path("package.json"))
	await makeDirectories(scratch.path("packages/core/out"), scratch.path("docker/out"))
	await writeLocalJSONFile({ name: "@mailwoman/core" }, scratch.path("packages/core/package.json"))
	await writeLocalTextFile("stale", scratch.path("packages/core/out/stale.js"))
	await writeLocalTextFile("metadata", scratch.path("packages/core/tsconfig.tsbuildinfo"))
	await writeLocalTextFile("stale", scratch.path("docker/out/stale.js"))

	return scratch
}

describe("release.clean", () => {
	test("reports the complete plan without writing during a dry run", async () => {
		await using scratch = await fixture()
		const log: string[] = []

		const result = await cleanOperation.run(
			{},
			{ repoRoot: scratch.path.toString(), dryRun: true, log: (line) => void log.push(line) }
		)

		expect(result).toEqual({
			dryRun: true,
			directories: ["packages/core/out", "docker/out"],
			files: ["packages/core/tsconfig.tsbuildinfo"],
		})

		expect(log).toContain("Would clean packages/core/out")
		expect(await pathExists(scratch.path("packages/core/out/stale.js"))).toBe(true)
		expect(await pathExists(scratch.path("packages/core/tsconfig.tsbuildinfo"))).toBe(true)
	})

	test("removes stale outputs, recreates output directories, and removes build metadata", async () => {
		await using scratch = await fixture()
		const result = await cleanOperation.run({}, { repoRoot: scratch.path.toString(), dryRun: false, log: () => {} })

		expect(result).toMatchObject({ dryRun: false })
		expect(await pathExists(scratch.path("packages/core/out"))).toBe(true)
		expect(await pathExists(scratch.path("packages/core/out/stale.js"))).toBe(false)
		expect(await pathExists(scratch.path("packages/core/tsconfig.tsbuildinfo"))).toBe(false)
		expect(await pathExists(scratch.path("docker/out/stale.js"))).toBe(false)
	})
})
