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

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { workspacePath } from "@mailwoman/core/utils"
import { execFile } from "@mailwoman/platform/child_process"
import { existsSync } from "@mailwoman/platform/fs"
import { readFile } from "@mailwoman/platform/fs/promises"
import { promisify } from "@mailwoman/platform/util"
import { BUNDLES } from "mailwoman/data-bundles"
import { afterAll, describe, expect, test } from "vitest"

const exec = promisify(execFile)

const cliBin = workspacePath("mailwoman", "out", "cli.js")

/**
 * A directory that exists but holds nothing — so `data --list` reports destinations under it without any bundle
 * appearing installed.
 */
const emptyDataRoot = await temporaryDirectory("mw-data-cli-")

afterAll(() => emptyDataRoot[Symbol.asyncDispose]())

describe.skipIf(!existsSync(cliBin))("mailwoman data (group landing page)", () => {
	test("bare `data` explains why the command exists and points at pull / status / doctor", async () => {
		const { stdout } = await exec("node", [cliBin, "data"], {
			env: childEnv({ NODE_NO_WARNINGS: "1", MAILWOMAN_DATA_ROOT: emptyDataRoot.path }),
			maxBuffer: 4 * 1024 * 1024,
		})

		expect(stdout).toMatch(/mailwoman data pull/)
		expect(stdout).toMatch(/mailwoman data status/)
		// The #1577 ask: the landing page has to hand the reader off to doctor.
		expect(stdout).toMatch(/mailwoman doctor/)
		expect(stdout).toContain(emptyDataRoot.path)
	}, 60_000)

	test("--list names every registered bundle, its size, and where it lands", async () => {
		const { stdout } = await exec("node", [cliBin, "data", "--list"], {
			env: childEnv({ NODE_NO_WARNINGS: "1", MAILWOMAN_DATA_ROOT: emptyDataRoot.path }),
			maxBuffer: 4 * 1024 * 1024,
		})

		for (const name of Object.keys(BUNDLES)) {
			expect(stdout).toMatch(new RegExp(`^  ${name}$`, "mu"))
		}

		// Sizes read in GB at this scale — "41261.8 MB" was the pre-fix rendering and is unreadable.
		expect(stdout).toMatch(/41\.3 GB/)
		expect(stdout).toContain(emptyDataRoot.path)
	}, 60_000)

	test("the subcommands survive the group's own index command", async () => {
		const { stdout } = await exec("node", [cliBin, "data", "--help"], {
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
		const manifest = parseJSONStrict<{ bin: Record<string, string> }>(
			await readFile(workspacePath("mailwoman", "package.json"), "utf8")
		)

		expect(manifest.bin).toEqual({ mailwoman: "./out/cli.js", mw: "./out/cli.js" })
	})
})
