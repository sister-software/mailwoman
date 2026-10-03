import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { temporaryDirectory } from "#fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "#fs/writers"
import { pathToFileURL } from "#module/file-url"
import { resolvePackageCommand } from "#module/package-command"

/** Plants an installed package independently of the resolver being tested. */
async function installFixture(
	root: PathBuilder,
	bin: string | Record<string, string>,
	files: Record<string, string>
): Promise<string> {
	const directory = root("node_modules", "@fixture", "tool")

	await writeLocalJSONFile(
		{ name: "@fixture/tool", main: "index.js", exports: { ".": "./index.js" }, bin },
		directory("package.json")
	)
	await writeLocalTextFile("export {}\n", directory("index.js"))
	for (const [file, text] of Object.entries(files)) await writeLocalTextFile(text, directory(file))

	return directory.toString()
}

describe("resolvePackageCommand", () => {
	it("uses the nearest dependency and preserves spaces in executable paths", async () => {
		await using scratch = await temporaryDirectory("package-command-")
		const project = scratch.path("project with spaces")

		await installFixture(scratch.path, { tool: "bin/hoisted.cjs" }, { "bin/hoisted.cjs": "// hoisted\n" })
		const nested = await installFixture(
			project,
			{ tool: "bin/nested launcher.cjs" },
			{ "bin/nested launcher.cjs": "// nested\n" }
		)
		const base = pathToFileURL(project("src", "caller.ts")).href

		expect(await resolvePackageCommand(base, "@fixture/tool", "tool")).toEqual({
			file: process.execPath,
			argv: [`${nested}/bin/nested launcher.cjs`],
		})
	})

	it("runs an extensionless Node launcher without a .bin shim or exported bin subpath", async () => {
		await using scratch = await temporaryDirectory("package-node-bin-")
		const packageRoot = await installFixture(
			scratch.path,
			{ tool: "bin/tool" },
			{ "bin/tool": "#!/usr/bin/env node\n" }
		)
		const base = pathToFileURL(scratch.path("caller.ts")).href

		expect(await resolvePackageCommand(base, "@fixture/tool", "tool")).toEqual({
			file: process.execPath,
			argv: [`${packageRoot}/bin/tool`],
		})
	})

	it("reads a string bin field using the unscoped package name", async () => {
		await using scratch = await temporaryDirectory("package-string-bin-")
		const packageRoot = await installFixture(scratch.path, "bin/tool.js", { "bin/tool.js": "// launcher\n" })
		const base = pathToFileURL(scratch.path("caller.ts")).href

		expect(await resolvePackageCommand(base, "@fixture/tool", "tool")).toEqual({
			file: process.execPath,
			argv: [`${packageRoot}/bin/tool.js`],
		})
		await expect(resolvePackageCommand(base, "@fixture/tool", "another-command")).rejects.toThrow(
			"no bin entry for another-command"
		)
	})

	it("returns a non-Node executable directly", async () => {
		await using scratch = await temporaryDirectory("package-native-bin-")
		const packageRoot = await installFixture(scratch.path, { tool: "bin/tool" }, { "bin/tool": "#!/bin/sh\n" })
		const base = pathToFileURL(scratch.path("caller.ts")).href

		expect(await resolvePackageCommand(base, "@fixture/tool", "tool")).toEqual({
			file: `${packageRoot}/bin/tool`,
			argv: [],
		})
	})

	it("raises when the named executable is missing or undeclared", async () => {
		await using scratch = await temporaryDirectory("package-missing-bin-")
		await installFixture(scratch.path, { tool: "bin/missing.cjs" }, {})
		const base = pathToFileURL(scratch.path("caller.ts")).href

		await expect(resolvePackageCommand(base, "@fixture/tool", "tool")).rejects.toThrow()
		await expect(resolvePackageCommand(base, "@fixture/tool", "absent")).rejects.toThrow("no bin entry for absent")
		await expect(resolvePackageCommand(base, "@fixture/not-installed", "tool")).rejects.toThrow()
	})
})
