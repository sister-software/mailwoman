/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { isRegisteredWorkspace, readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"
import { describe, expect, test } from "vitest"

async function scaffold(workspaces: string[], directories: string[], files: string[] = []) {
	const scratch = await temporaryDirectory("mw-workspaces-")
	const root = scratch.path

	await writeLocalJSONFile({ workspaces }, resolvePath(root, "package.json"))

	for (const directory of directories) {
		await makeDirectories(resolvePath(root, directory))
		await writeLocalJSONFile({ name: directory }, resolvePath(root, directory, "package.json"))
	}

	for (const file of files) {
		await makeDirectories(resolvePath(root, file, ".."))
		await writeLocalTextFile("", resolvePath(root, file))
	}

	return scratch
}

describe("readWorkspaceDirectories", () => {
	test("a literal entry stays in place and a trailing-star entry expands to the children that carry a manifest, sorted", async () => {
		await using scratch = await scaffold(
			["docs", "packages/*"],
			["docs", "packages/b", "packages/a"],
			["packages/README.md", "packages/empty/.keep"]
		)

		expect(await readWorkspaceDirectories(scratch.path)).toEqual(["docs", "packages/a", "packages/b"])
	})

	test("a literal entry without a manifest is an error, not an absence", async () => {
		await using scratch = await scaffold(["docs", "packages/*"], ["packages/a"])

		await expect(readWorkspaceDirectories(scratch.path)).rejects.toThrow(/workspace docs has no package.json/u)
	})

	test("a pattern that is not a single trailing star is refused", async () => {
		await using scratch = await scaffold(["packages/**"], ["packages/a"])

		await expect(readWorkspaceDirectories(scratch.path)).rejects.toThrow(/not a single trailing/u)
	})

	test("a pattern that matches nothing is refused", async () => {
		await using scratch = await scaffold(["packages/*"], [], ["packages/README.md"])

		await expect(readWorkspaceDirectories(scratch.path)).rejects.toThrow(/matched no directory/u)
	})

	test("the repository's own field expands to the packages plus docs", async () => {
		const directories = await readWorkspaceDirectories(repoRootPath())

		expect(directories).toContain("docs")
		expect(directories).toContain("packages/core")
		expect(directories).toContain("packages/earth")
		expect(directories.length).toBeGreaterThanOrEqual(70)
		expect(await isRegisteredWorkspace(repoRootPath(), "packages/core")).toBe(true)
		expect(await isRegisteredWorkspace(repoRootPath(), "packages/nowhere")).toBe(false)
	})
})
