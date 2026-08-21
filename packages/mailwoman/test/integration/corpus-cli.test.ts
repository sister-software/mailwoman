/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration test for `npx mailwoman corpus list` + `corpus run`. Spawns the compiled CLI binary
 *   and verifies exit codes + output shape. While the shard registry ships empty, the only behavior
 *   there is to assert is the empty-registry messaging.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { childEnv } from "@mailwoman/core/scripting/utils"
import { workspacePath, repoRootPath } from "@mailwoman/core/utils"
import { parseCommand } from "mailwoman/cli-native/spec"
import { spec as runSpec } from "mailwoman/commands/corpus/run"
import { withCLISpawnLockAsync } from "mailwoman/test-kit/cli-spawn-lock"
import { describe, expect, test, vi } from "vitest"

/**
 * Wall-clock budget for a CLI spawn — see the note in `mailwoman/commands/geocode.test.ts`. A single spawn costs ~5.6
 * s, 2.7 s of it node boot alone.
 */
const CLI_SPAWN_TIMEOUT_MS = 45_000

/**
 * Vitest's own per-test budget. It has to exceed {@link CLI_SPAWN_TIMEOUT_MS} plus time queued on the spawn lock — a
 * per-test timeout below the child's timeout means vitest kills the test before the thing it is measuring can report,
 * which reads as "timed out" with no indication of what actually took the time.
 */
const CLI_TEST_TIMEOUT_MS = 90_000

/**
 * Vitest's per-test budget for this whole file.
 *
 * Set at file scope rather than per test: every test here spawns the compiled CLI, which costs seconds before any
 * assertion runs and then queues behind {@link withCLISpawnLock}. A per-test annotation has to be remembered on each new
 * test, and the one that forgets inherits the global 15s — which kills the test before the thing being measured can
 * report, surfacing as a bare timeout with no attribution.
 */
vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })

const exec = promisify(execFile)
const cliBin = workspacePath("mailwoman", "out", "cli.js")

describe("corpus run option validation", () => {
	test("rejects non-alpha-2 country", () => {
		expect(() => parseCommand(runSpec, ["adapter", "--input", "x", "--output", "y", "--country", "USA"])).toThrow(
			/country/
		)

		expect(() => parseCommand(runSpec, ["adapter", "--input", "x", "--output", "y", "--country", "us"])).toThrow(
			/country/
		)

		expect(() => parseCommand(runSpec, ["adapter", "--input", "x", "--output", "y", "--country", "FR"])).not.toThrow()
	})

	test("limit must be a positive integer", () => {
		for (const limit of ["0", "-1"]) {
			expect(() => parseCommand(runSpec, ["adapter", "--input", "x", "--output", "y", "--limit", limit])).toThrow(
				/limit/
			)
		}

		expect(() => parseCommand(runSpec, ["adapter", "--input", "x", "--output", "y", "--limit", "10"])).not.toThrow()
	})

	test("input + output are required; corpusVersion defaults to 0.1.0-dev", () => {
		expect(() => parseCommand(runSpec, ["adapter", "--output", "y"])).toThrow(/input/)
		expect(() => parseCommand(runSpec, ["adapter", "--input", "x"])).toThrow(/output/)
		const parsed = parseCommand(runSpec, ["adapter", "--input", "x", "--output", "y"])
		expect(parsed.values["corpus-version"]).toBe("0.1.0-dev")
		expect(parsed.values["progress-every"]).toBe(1000)
	})
})

describe("npx mailwoman corpus list", () => {
	test(
		"exits 0 and includes every registered adapter id",
		async () => {
			// NODE_NO_WARNINGS=1 silences Node deprecation chatter (e.g. DEP0040
			// punycode noise from a transitive dep on Node 22) that would
			// otherwise pollute stderr and break the `stderr === ""` assertion.
			const { stdout, stderr } = await withCLISpawnLockAsync(() =>
				exec("node", [cliBin, "corpus", "list"], {
					timeout: CLI_SPAWN_TIMEOUT_MS,
					env: childEnv({ NODE_NO_WARNINGS: "1" }),
				})
			)

			expect(stderr).toBe("")
			expect(stdout).toMatch(/wof-admin/i)
			expect(stdout).toMatch(/CC0/i)
		},
		CLI_TEST_TIMEOUT_MS
	)
})

describe("npx mailwoman corpus run <unknown> --input x --output y", () => {
	test(
		"exits non-zero and names the unknown adapter",
		async () => {
			await expect(
				withCLISpawnLockAsync(() =>
					exec("node", [cliBin, "corpus", "run", "nope-not-real", "--input", "/tmp/x", "--output", "/tmp/y"], {
						timeout: CLI_SPAWN_TIMEOUT_MS,
					})
				)
			).rejects.toMatchObject({
				code: 1,
				stdout: expect.stringMatching(/unknown adapter id .*nope-not-real/),
			})
		},
		CLI_TEST_TIMEOUT_MS
	)
})
