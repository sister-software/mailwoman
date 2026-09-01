/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI integration tests for the `mailwoman data` command GROUP itself (#1577) — the `index.tsx`
 *   landing page, not `pull`/`status`. Runs the compiled CLI (`out/cli.js`, the standing "use the
 *   compiled CLI" rule) with an isolated empty data root so nothing here depends on which layers this
 *   machine happens to have downloaded, and touches no network: both code paths are pure registry
 *   reads.
 *
 *   Also pins the `mw` bin alias, because the failure mode is silent: `bin` is a manifest field
 *   nothing in the build reads, so dropping a name back to the string form (`"bin": "./out/cli.js"`)
 *   type-checks, tests, and publishes — and only the consumer who typed `mw` finds out.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { BUNDLES } from "mailwoman/data"
import { afterAll, describe, expect, test } from "vitest"

const cliBin = workspacePath("mailwoman", "out", "cli.js")

/**
 * A directory that exists but holds nothing — so `data --list` reports destinations under it without any bundle
 * appearing installed.
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
		// The #1577 ask: the landing page has to hand the reader off to doctor.
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

		// Sizes read in GB at this scale — "41261.8 MB" was the pre-fix rendering and is unreadable.
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
		const manifest = await readLocalJSONFile<{ bin: Record<string, string> }>(
			workspacePath("mailwoman", "package.json")
		)

		expect(manifest.bin).toEqual({ mailwoman: "./out/cli.js", mw: "./out/cli.js" })
	})
})
