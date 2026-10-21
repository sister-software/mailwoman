/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The non-interactive wizard on the compiled CLI, as a first-run smoke: it reports the roots, runs the sample parse
 *   and lists the tiers for the asked country. Run `yarn compile` before this suite.
 */

import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { describe, expect, test, vi } from "vitest"

import { mailwomanCLIPath } from "#metadata"
import { withCLISpawnLockAsync } from "#test-kit/cli-spawn-lock"

const CLI_SPAWN_TIMEOUT_MS = 120_000
const CLI_TEST_TIMEOUT_MS = 180_000

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })

const cliBin = await mailwomanCLIPath()

describe("mailwoman setup --no-interactive", () => {
	test("prints the roots, the sample parse and the tiers for the asked country, and exits 0", async () => {
		const { stdout } = await withCLISpawnLockAsync(() =>
			runFile(process.execPath, [cliBin, "setup", "--no-interactive", "--countries", "GB"], {
				env: childEnv({ NODE_NO_WARNINGS: "1" }),
				maxBuffer: 4 * 1024 * 1024,
				timeout: CLI_SPAWN_TIMEOUT_MS,
			})
		)

		expect(stdout).toContain("Data root:")
		expect(stdout).toContain("Config root:")
		expect(stdout).toMatch(/^Parsed: /mu)
		expect(stdout).toContain("Tiers:")
		expect(stdout).toContain("  candidate")
	})
})
