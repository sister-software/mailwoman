/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration test for `npx mailwoman corpus list` + `corpus run`. Spawns the compiled CLI binary
 *   and verifies exit codes + output shape. While the database registry ships empty, the only behavior
 *   there is to assert is the empty-registry messaging.
 */

import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { spec as runSpec } from "mailwoman/commands/corpus/run"
import { describe, expect, test, vi } from "vitest"

import { parseCommand } from "#cli/native/spec"
import { mailwomanCLIPath } from "#metadata"
import { withCLISpawnLockAsync } from "#test-kit/cli-spawn-lock"

/**
 * Wall-clock budget for a CLI spawn.
 * See the note in `mailwoman/commands/geocode.test.ts`.
 *
 * A single spawn costs ~5.6 s, including 2.7 s of node boot.
 */
const CLI_SPAWN_TIMEOUT_MS = 45_000

/**
 * Vitest's own per-test budget.
 *
 * It has to exceed {@link CLI_SPAWN_TIMEOUT_MS} plus time queued on the spawn lock.
 * A per-test timeout below the child's timeout lets Vitest kill the test before the child reports.
 *
 * The failure then reports "timed out" without identifying what consumed the time.
 */
const CLI_TEST_TIMEOUT_MS = 90_000

/**
 * Vitest's per-test budget for this whole file.
 *
 * Set the timeout at file scope because every test spawns the compiled CLI.
 * Startup takes seconds before assertions, then each test queues behind {@link withCLISpawnLockAsync}.
 *
 * A new test can omit its per-test annotation.
 * It would inherit the global 15s timeout.
 *
 * That timeout can kill the operation before it reports.
 * The failure then reports timeout without attribution.
 */
vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })

const cliBin = await mailwomanCLIPath()

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

	test("input + out are required; corpusVersion defaults to 0.1.0-dev", () => {
		expect(() => parseCommand(runSpec, ["adapter", "--out", "y"])).toThrow(/input/)
		expect(() => parseCommand(runSpec, ["adapter", "--input", "x"])).toThrow(/out/)
		const parsed = parseCommand(runSpec, ["adapter", "--input", "x", "--out", "y"])
		expect(parsed.values["corpus-version"]).toBe("0.1.0-dev")
		expect(parsed.values["progress-every"]).toBe(1000)
	})

	test("the retired --output still satisfies the requirement it used to", () => {
		// The alias is checked here and not only in the spec unit test, because `out` is `required`
		// and the required check reads the current key: an alias folded in after that check would make
		// every existing caller fail with "Missing required option: --out" while passing a destination.
		const parsed = parseCommand(runSpec, ["adapter", "--input", "x", "--output", "y"])

		expect(parsed.values.out).toBe("y")
	})
})

describe("npx mailwoman corpus list", () => {
	test(
		"exits 0 and includes every registered adapter id",
		async () => {
			// NODE_NO_WARNINGS=1 silences Node deprecation chatter (e.g. DEP0040 punycode noise from a transitive dep on Node 22) that would otherwise pollute stderr and break the `stderr === ""` assertion.
			const { stdout, stderr } = await withCLISpawnLockAsync(() =>
				runFile("node", [cliBin, "corpus", "list"], {
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
					runFile("node", [cliBin, "corpus", "run", "nope-not-real", "--input", "/tmp/x", "--output", "/tmp/y"], {
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
