/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { WorkspacePackages } from "@mailwoman/core/module/workspace"
import { resolvePath } from "path-ts"
import { describe, expect, test } from "vitest"

describe("WorkspacePackages", () => {
	test("maps manifest package names to declared workspace directories", async () => {
		await using scratch = await temporaryDirectory("mw-workspace-packages-")

		await writeLocalJSONFile({ workspaces: ["docs", "packages/*"] }, resolvePath(scratch.path, "package.json"))
		await makeDirectories(scratch.path("docs"), scratch.path("packages/core"))
		await writeLocalJSONFile({ name: "@mailwoman/docs" }, scratch.path("docs/package.json"))
		await writeLocalJSONFile({ name: "@mailwoman/core" }, scratch.path("packages/core/package.json"))

		const packages = await WorkspacePackages.read(scratch.path)
		const core = "@mailwoman/core"

		expect(packages.packageCount).toBe(2)
		expect(packages.validate(core)).toBe(true)

		if (!packages.validate(core)) throw new Error("Expected core fixture to be a workspace package")

		expect(packages.packagePathBuilder(core).toString()).toBe(scratch.path("packages/core").toString())
		expect(packages.tsOutPathBuilder(core).toString()).toBe(scratch.path("packages/core/out").toString())
		expect(packages.distPathBuilder(core).toString()).toBe(scratch.path("packages/core/dist").toString())
	})
})
