/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `valeCommand` — where the prose linter is, and what it does when the binary is not there.
 *
 *   The package publishes a Node launcher around a binary its postinstall downloads separately. The download can fail
 *   while the install succeeds, and the launcher then exits 1 with a message on stderr — the same exit code a prose
 *   finding produces. These tests fix the two shapes apart: a package whose binary is present resolves to a command,
 *   and a package whose binary is missing raises before anything spawns.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { valeCommand } from "@mailwoman/core/vale"
import { describe, expect, it } from "vitest"

/**
 * A fixture `@vvago/vale` installation, and a module URL inside it to resolve from.
 *
 * The launcher shape is what ships today: `bin.vale` names a `.cjs` file and the binary lives beside it under
 * `native/`. `withBinary: false` reproduces an install whose postinstall download failed.
 */
async function fixtureInstall(
	root: string,
	{ withBinary }: { withBinary: boolean }
): Promise<{ base: string; packageRoot: string }> {
	const packageRoot = `${root}/node_modules/@vvago/vale`

	await makeDirectories(`${packageRoot}/bin`)

	await writeLocalJSONFile(
		{ name: "@vvago/vale", version: "3.20.0", bin: { vale: "./bin/vale.cjs" } },
		`${packageRoot}/package.json`
	)

	await writeLocalTextFile("// launcher\n", `${packageRoot}/bin/vale.cjs`)

	if (withBinary) {
		await makeDirectories(`${packageRoot}/native`)
		await writeLocalTextFile("#!/bin/sh\n", `${packageRoot}/native/vale`)
	}

	await writeLocalTextFile("export {}\n", `${root}/caller.ts`)

	return { base: pathToFileURL(`${root}/caller.ts`).href, packageRoot }
}

describe("valeCommand", () => {
	it("spawns this Node with the launcher when the binary is in place", async () => {
		await using scratch = await temporaryDirectory("mw-vale-ok-")
		const { base, packageRoot } = await fixtureInstall(String(scratch.path), { withBinary: true })

		const command = await valeCommand(base)

		expect(command.file).toBe(process.execPath)
		expect(command.argv).toEqual([`${packageRoot}/bin/vale.cjs`])
	})

	it("raises before spawning when the launcher has no binary to launch", async () => {
		await using scratch = await temporaryDirectory("mw-vale-missing-")
		const { base } = await fixtureInstall(String(scratch.path), { withBinary: false })

		// The launcher would exit 1 with a message on stderr, which a caller reading the exit status alone reports as a
		// prose failure. The error names the download instead.
		await expect(valeCommand(base)).rejects.toThrow(/does not exist, so no prose check ran/)
	})
})
