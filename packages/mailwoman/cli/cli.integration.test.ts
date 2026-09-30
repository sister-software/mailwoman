/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the compiled CLI with an isolated empty data root. It pins the `mw` bin alias because `bin` is a manifest field no part of the build reads.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { afterAll, describe, expect, test } from "vitest"

import { BUNDLES } from "#data"
import { mailwomanCLIPath } from "#metadata"

const cliBin = await mailwomanCLIPath()

/**
 * A directory that exists but holds no files, so `data --list` reports destinations
 * under it without any bundle appearing installed.
 */
const emptyDataRoot = await temporaryDirectory("mw-data-cli-")
const emptyDataRootPath = emptyDataRoot.path.toString()

afterAll(() => emptyDataRoot[Symbol.asyncDispose]())

describe.skipIf(!(await pathExists(cliBin)))("mailwoman data (group landing page)", () => {
	test("bare `data` explains why the command exists and points at pull / status / doctor", async () => {
		const { stdout } = await runFile("node", [cliBin, "data"], {
			env: childEnv({ NODE_NO_WARNINGS: "1", MAILWOMAN_DATA_ROOT: emptyDataRootPath }),
			maxBuffer: 4 * 1024 * 1024,
		})

		expect(stdout).toMatch(/mailwoman data pull/)
		expect(stdout).toMatch(/mailwoman data status/)
		expect(stdout).toMatch(/mailwoman doctor/)
		expect(stdout).toContain(emptyDataRootPath)
	}, 60_000)

	test("--list names every registered bundle, its size, and where it lands", async () => {
		const { stdout } = await runFile("node", [cliBin, "data", "--list"], {
			env: childEnv({ NODE_NO_WARNINGS: "1", MAILWOMAN_DATA_ROOT: emptyDataRootPath }),
			maxBuffer: 4 * 1024 * 1024,
		})

		for (const name of Object.keys(BUNDLES)) {
			expect(stdout).toMatch(new RegExp(`^  ${name}$`, "mu"))
		}

		// Sizes read in GB at this scale.
		expect(stdout).toMatch(/41\.3 GB/)
		expect(stdout).toContain(emptyDataRootPath)
	}, 60_000)

	test("the subcommands survive the group's own index command", async () => {
		const { stdout } = await runFile("node", [cliBin, "data", "--help"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})

		expect(stdout).toMatch(/\bpull\b/)
		expect(stdout).toMatch(/\bstatus\b/)
		expect(stdout).toMatch(/--list/)
	}, 60_000)
})

describe("the published bin names", () => {
	test("`mailwoman` and `mw` both point at the compiled CLI", async () => {
		const manifest = await readPackageJSON(workspacePath("mailwoman", "package.json"))

		expect(manifest.bin).toEqual({ mailwoman: "./out/cli/main.js", mw: "./out/cli/main.js" })
	})
})
