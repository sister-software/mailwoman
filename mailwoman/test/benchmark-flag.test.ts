/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI `--benchmark` flag tests. Validates the schema and exercises the runner end-to-end against
 *   the compiled CLI (no neural model load — uses --no-neural so the test is deterministic +
 *   fast).
 */

import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, test } from "vitest"

import { options as parseOptions } from "../commands/parse.js"

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(import.meta.url), "../..")
const cliBin = resolve(repoRoot, "out", "cli.js")

describe("--benchmark schema", () => {
	test("accepts integer in [1, 10000]", () => {
		expect(() => parseOptions.parse({ benchmark: 1 })).not.toThrow()
		expect(() => parseOptions.parse({ benchmark: 100 })).not.toThrow()
		expect(() => parseOptions.parse({ benchmark: 10000 })).not.toThrow()
	})

	test("coerces numeric strings", () => {
		const parsed = parseOptions.parse({ benchmark: "50" } as unknown as Record<string, unknown>)
		expect(parsed.benchmark).toBe(50)
	})

	test("rejects out-of-range values", () => {
		expect(() => parseOptions.parse({ benchmark: 0 })).toThrow()
		expect(() => parseOptions.parse({ benchmark: -1 })).toThrow()
		expect(() => parseOptions.parse({ benchmark: 10001 })).toThrow()
	})

	test("rejects non-integers", () => {
		expect(() => parseOptions.parse({ benchmark: 1.5 })).toThrow()
	})

	test("benchmark is optional", () => {
		expect(() => parseOptions.parse({})).not.toThrow()
	})
})

describe("npx mailwoman parse --benchmark <N> --no-neural '<input>'", () => {
	test("emits the percentile report and exits 0", async () => {
		const { stdout } = await exec(
			process.execPath,
			[cliBin, "parse", "--benchmark", "10", "--no-neural", "350 5th Ave, New York, NY 10118"],
			{ env: { ...process.env, MAILWOMAN_TEST_MODE: "1" } }
		)
		expect(stdout).toContain("iterations + 5 warmup")
		expect(stdout).toContain("stage")
		expect(stdout).toContain("p50")
		expect(stdout).toContain("TOTAL")
		expect(stdout).toContain("normalize")
		expect(stdout).toContain("query-shape")
		expect(stdout).toContain("heap delta")
	}, 30000)

	test("rejects --benchmark with --isolated", async () => {
		let err: (Error & { stderr?: string; stdout?: string; code?: number }) | undefined

		try {
			await exec(process.execPath, [cliBin, "parse", "--benchmark", "5", "--isolated", "--no-neural", "hello world"])
		} catch (e) {
			err = e as Error & { stderr?: string; stdout?: string; code?: number }
		}
		expect(err).toBeDefined()
		// Ink renders the error to stdout (Text color=red), not stderr. Process exits 1 because the
		// useEffect-driven setError(...) → setImmediate(() => process.exit(1)) path fires.
		const combined = `${err?.stdout ?? ""}${err?.stderr ?? ""}`
		expect(combined).toMatch(/--benchmark requires the default runtime-pipeline path/)
	}, 30000)
})
