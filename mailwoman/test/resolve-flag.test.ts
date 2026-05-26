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

	test("--candidates surfaces runner-up resolutions in XML", async () => {
		// "Springfield, Illinois" — the region qualifier helps the model produce a resolvable tag.
		// WOF returns multiple Springfields (OR, PA, MA, etc.). With --candidates 5 we expect at
		// least one <alternative> element on the resolved node.
		const result = await exec(
			"node",
			[cliBin, "parse", "--resolve", "--candidates", "5", "--format", "xml", "Springfield, Illinois"],
			{ env: { ...process.env, MAILWOMAN_WOF_DB: wofPath, NODE_NO_WARNINGS: "1" }, maxBuffer: 4 * 1024 * 1024 }
		)
		expect(result.stdout).toContain("<address raw=")
		// At least one alternative element with a place attr.
		expect(result.stdout).toMatch(/<alternative[^>]*place="wof:\d+"/)
		expect(result.stdout).toMatch(/<alternative[^>]*name="/)
		expect(result.stdout).toMatch(/<alternative[^>]*lat="-?\d+\.\d+"/)
	}, 30_000)

	test("--candidates surfaces runner-up resolutions in JSON (tree shape)", async () => {
		const result = await exec(
			"node",
			[cliBin, "parse", "--resolve", "--candidates", "3", "--format", "json", "Springfield, Illinois"],
			{ env: { ...process.env, MAILWOMAN_WOF_DB: wofPath, NODE_NO_WARNINGS: "1" }, maxBuffer: 4 * 1024 * 1024 }
		)
		// JSON with --candidates dumps the full AddressTree, not the libpostal-flat projection.
		// The tree carries `roots` with nodes that have `alternatives`.
		const tree = JSON.parse(stripAnsiSpinner(result.stdout))
		expect(tree).toHaveProperty("raw")
		expect(tree).toHaveProperty("roots")
		// At least one root should have alternatives (Springfield is ambiguous).
		const hasAlternatives = (tree.roots as Array<{ alternatives?: unknown[] }>).some(
			(r) => Array.isArray(r.alternatives) && r.alternatives.length > 0
		)
		expect(hasAlternatives).toBe(true)
	}, 30_000)

	test("without --candidates, JSON stays libpostal-flat (no tree shape leak)", async () => {
		const result = await exec("node", [cliBin, "parse", "--resolve", "--format", "json", "Springfield"], {
			env: { ...process.env, MAILWOMAN_WOF_DB: wofPath, NODE_NO_WARNINGS: "1" },
			maxBuffer: 4 * 1024 * 1024,
		})
		const out = JSON.parse(stripAnsiSpinner(result.stdout))
		// Libpostal-compat is flat: no `raw` / `roots` top-level keys.
		expect(out).not.toHaveProperty("raw")
		expect(out).not.toHaveProperty("roots")
	}, 30_000)
})

/** Strip ANSI escape sequences + ink spinner frames so JSON.parse can consume CLI stdout. */
function stripAnsiSpinner(stdout: string): string {
	const ansi = /\[[0-9;]*[a-zA-Z]/gu
	const cleaned = stdout.replace(ansi, "").trim()
	// Find the start of the JSON payload (`{` or `[`).
	const objStart = cleaned.search(/[{[]/)
	return objStart >= 0 ? cleaned.slice(objStart) : cleaned
}

if (!hasWofDb) {
	describe.skip("--resolve end-to-end", () => {
		test(`skipped (WOF DB not present at ${wofPath} — set MAILWOMAN_WOF_DB)`, () => {})
	})
}
