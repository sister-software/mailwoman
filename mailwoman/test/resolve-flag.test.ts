/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI integration tests for `parse --neural --resolve` (Phase 4.3).
 *
 *   Schema-level tests run unconditionally. End-to-end tests gate on a real WOF SQLite distribution
 *   being on disk (skip-if-missing via `describe.skipIf`), matching the pattern in
 *   `resolver-wof-sqlite/integration.test.ts`.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, test } from "vitest"
import { options as parseOptions } from "../commands/parse.js"

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(import.meta.url), "../..")
const cliBin = resolve(repoRoot, "out", "cli.js")

const DEFAULT_WOF_PATH = "/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db"
const wofPath = process.env["MAILWOMAN_WOF_DB"] ?? DEFAULT_WOF_PATH
const hasWofDb = existsSync(wofPath)
const describeIfWof = describe.skipIf(!hasWofDb)

describe("--resolve schema validation", () => {
	test("--resolve defaults to false", () => {
		expect(parseOptions.parse({}).resolve).toBe(false)
	})

	test("--resolve accepts true", () => {
		expect(parseOptions.parse({ resolve: true, neural: true }).resolve).toBe(true)
	})

	test("--resolve-db accepts an arbitrary path string", () => {
		expect(parseOptions.parse({ resolveDb: "/tmp/wof.db" }).resolveDb).toBe("/tmp/wof.db")
	})
})

describe("npx mailwoman parse --resolve error paths", () => {
	test("--resolve without a WOF DB path exits non-zero with a clear message", async () => {
		// As of the pipeline-default flip, --resolve works without --neural — the runtime pipeline
		// handles classification + resolution end-to-end. The remaining error path is "no WOF SQLite
		// distribution available".
		await expect(
			exec("node", [cliBin, "parse", "--resolve", "123 Main St"], {
				env: { ...process.env, MAILWOMAN_WOF_DB: "" },
			})
		).rejects.toMatchObject({
			stdout: expect.stringMatching(/needs a WOF SQLite path/),
		})
	})
})

describeIfWof(`npx mailwoman parse --neural --resolve against ${wofPath}`, () => {
	test("emits resolver-decorated XML for a known US locality", async () => {
		const result = await exec(
			"node",
			[cliBin, "parse", "--neural", "--resolve", "--format", "xml", "Springfield, Illinois"],
			{ env: { ...process.env, MAILWOMAN_WOF_DB: wofPath, NODE_NO_WARNINGS: "1" }, maxBuffer: 4 * 1024 * 1024 }
		)
		// The XML root is always present.
		expect(result.stdout).toContain("<address raw=")
		// At least one node gained resolver attribution. The exact wof id varies by FTS ranking, but
		// the `place="wof:<digits>"` shape + the `lat=` / `lon=` attrs are stable.
		expect(result.stdout).toMatch(/src="resolver:[a-z_]+:\d+"/)
		expect(result.stdout).toMatch(/place="wof:\d+"/)
		expect(result.stdout).toMatch(/lat="-?\d+\.\d+"/)
		expect(result.stdout).toMatch(/lon="-?\d+\.\d+"/)
	}, 30_000)

	test("respects --resolve-db explicit path override (matches env default)", async () => {
		// Use the same input as the first test — the neural classifier needs enough context to tag
		// component spans; bare single-token names like "Houston" alone often parse to nothing.
		const result = await exec(
			"node",
			[cliBin, "parse", "--neural", "--resolve", "--resolve-db", wofPath, "--format", "xml", "Springfield, Illinois"],
			{ env: { ...process.env, NODE_NO_WARNINGS: "1" }, maxBuffer: 4 * 1024 * 1024 }
		)
		expect(result.stdout).toContain("<address raw=")
		expect(result.stdout).toMatch(/src="resolver:/)
	}, 30_000)

	test("works without --resolve (regression check — flag default is off)", async () => {
		const result = await exec("node", [cliBin, "parse", "--neural", "--format", "xml", "Springfield, Illinois"], {
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			maxBuffer: 4 * 1024 * 1024,
		})
		expect(result.stdout).toContain("<address raw=")
		// Without --resolve, no resolver attribution.
		expect(result.stdout).not.toMatch(/src="resolver:/)
		expect(result.stdout).not.toMatch(/place="wof:/)
	}, 30_000)
})

if (!hasWofDb) {
	describe.skip("--resolve end-to-end", () => {
		test(`skipped (WOF DB not present at ${wofPath} — set MAILWOMAN_WOF_DB)`, () => {})
	})
}
