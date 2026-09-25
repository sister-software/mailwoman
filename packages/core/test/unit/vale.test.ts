/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests how `valeCommand` locates the Vale launcher and handles a missing binary.
 *
 *   The `@vvago/vale` postinstall downloads the binary separately and can fail while the install succeeds. The launcher
 *   then exits 1, the same exit code as a prose finding. `valeCommand` must therefore throw before it spawns anything.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { valeCommand } from "@mailwoman/core/vale"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

/**
 * Writes a fixture `@vvago/vale` install and returns a caller module URL to resolve from.
 *
 * The fixture's `bin.vale` points to a `.cjs` launcher, and the binary sits under `native/`.
 * `withBinary: false` simulates a failed postinstall download.
 */
async function fixtureInstall(
	root: PathBuilder,
	{ withBinary }: { withBinary: boolean }
): Promise<{ base: string; packageRoot: string }> {
	const packageRoot = root("node_modules", "@vvago", "vale")

	await makeDirectories(packageRoot("bin"))

	await writeLocalJSONFile(
		{ name: "@vvago/vale", version: "3.20.0", bin: { vale: "./bin/vale.cjs" } },
		packageRoot("package.json")
	)

	await writeLocalTextFile("// launcher\n", packageRoot("bin", "vale.cjs"))

	if (withBinary) {
		await makeDirectories(packageRoot("native"))
		await writeLocalTextFile("#!/bin/sh\n", packageRoot("native", "vale"))
	}

	await writeLocalTextFile("export {}\n", root("caller.ts"))

	return { base: pathToFileURL(root("caller.ts").toString()).href, packageRoot: packageRoot.toString() }
}

describe("valeCommand", () => {
	it("spawns this Node with the launcher when the binary is in place", async () => {
		await using scratch = await temporaryDirectory("mw-vale-ok-")
		const { base, packageRoot } = await fixtureInstall(scratch.path, { withBinary: true })

		const command = await valeCommand(base)

		expect(command.file).toBe(process.execPath)
		expect(command.argv).toEqual([`${packageRoot}/bin/vale.cjs`])
	})

	it("raises before spawning when the launcher has no binary to launch", async () => {
		await using scratch = await temporaryDirectory("mw-vale-missing-")
		const { base } = await fixtureInstall(scratch.path, { withBinary: false })

		await expect(valeCommand(base)).rejects.toThrow(/does not exist, so no prose check ran/)
	})
})
