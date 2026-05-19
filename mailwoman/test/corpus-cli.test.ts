/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration test for `npx mailwoman corpus list` + `corpus run`. Spawns the compiled CLI binary
 *   and verifies exit codes + output shape. The registry is empty during Phase 1 task 2; only
 *   behavior we can assert today is the empty-registry messaging.
 */

import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, test } from "vitest"
import { options as runOptions } from "../commands/corpus/run.js"

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(import.meta.url), "../..")
const cliBin = resolve(repoRoot, "out", "cli.js")

describe("corpus run schema validation", () => {
	test("rejects non-alpha-2 country", () => {
		expect(() => runOptions.parse({ input: "x", output: "y", country: "USA" })).toThrow()
		expect(() => runOptions.parse({ input: "x", output: "y", country: "us" })).toThrow()
		expect(() => runOptions.parse({ input: "x", output: "y", country: "FR" })).not.toThrow()
	})

	test("limit must be a positive integer", () => {
		expect(() => runOptions.parse({ input: "x", output: "y", limit: "0" })).toThrow()
		expect(() => runOptions.parse({ input: "x", output: "y", limit: "-1" })).toThrow()
		expect(() => runOptions.parse({ input: "x", output: "y", limit: "10" })).not.toThrow()
	})

	test("input + output are required; corpusVersion defaults to 0.1.0-dev", () => {
		expect(() => runOptions.parse({ output: "y" })).toThrow()
		expect(() => runOptions.parse({ input: "x" })).toThrow()
		const parsed = runOptions.parse({ input: "x", output: "y" })
		expect(parsed.corpusVersion).toBe("0.1.0-dev")
		expect(parsed.progressEvery).toBe(1_000)
	})
})

describe("npx mailwoman corpus list", () => {
	test("exits 0 and includes every registered adapter id", async () => {
		// NODE_NO_WARNINGS=1 silences Node deprecation chatter (e.g. DEP0040
		// punycode noise from a transitive dep on Node 22) that would
		// otherwise pollute stderr and break the `stderr === ""` assertion.
		const { stdout, stderr } = await exec("node", [cliBin, "corpus", "list"], {
			timeout: 10_000,
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
		})
		expect(stderr).toBe("")
		expect(stdout).toMatch(/wof-admin/i)
		expect(stdout).toMatch(/CC0/i)
	}, 15_000)
})

describe("npx mailwoman corpus run <unknown> --input x --output y", () => {
	test("exits non-zero and names the unknown adapter", async () => {
		await expect(
			exec("node", [cliBin, "corpus", "run", "nope-not-real", "--input", "/tmp/x", "--output", "/tmp/y"], {
				timeout: 10_000,
			})
		).rejects.toMatchObject({
			code: 1,
			stdout: expect.stringMatching(/unknown adapter id .*nope-not-real/),
		})
	}, 15_000)
})
