/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI `--benchmark` flag tests. Validates the schema and exercises the runner end-to-end against
 *   the compiled CLI with `--degraded`, so no encoder loads and the run stays deterministic + fast.
 *
 *   This used to pass `--no-neural`, which did NOT skip the load: `parse.tsx` declared both `neural`
 *   and `noNeural`, Commander derived `--no-neural` from the FORMER (its `attributeName()` is
 *   `neural`), and `options.noNeural` was therefore never settable from the command line. The
 *   benchmark reported `classifier: loaded (en-US)` throughout. `noNeural` is gone; `--degraded` is
 *   the flag that skips the encoder, and the benchmark path now honours it.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { childEnv } from "@mailwoman/core/scripting/utils"
import { workspacePath } from "@mailwoman/core/utils"
import { parseCommand } from "mailwoman/cli-native/spec"
import { spec as parseSpec } from "mailwoman/commands/parse"
import { describe, expect, test } from "vitest"

const exec = promisify(execFile)
const cliBin = workspacePath("mailwoman", "out", "cli.js")

describe("--benchmark option", () => {
	test("accepts integer in [1, 10000]", () => {
		for (const value of [1, 100, 10_000]) {
			expect(() => parseCommand(parseSpec, ["--benchmark", String(value), "address"])).not.toThrow()
		}
	})

	test("coerces numeric strings", () => {
		const parsed = parseCommand(parseSpec, ["--benchmark", "50", "address"])
		expect(parsed.values.benchmark).toBe(50)
	})

	test("rejects out-of-range values", () => {
		for (const value of [0, -1, 10_001]) {
			expect(() => parseCommand(parseSpec, ["--benchmark", String(value), "address"])).toThrow(/benchmark/)
		}
	})

	test("rejects non-integers", () => {
		expect(() => parseCommand(parseSpec, ["--benchmark", "1.5", "address"])).toThrow(/benchmark/)
	})

	test("benchmark is optional", () => {
		expect(() => parseCommand(parseSpec, ["address"])).not.toThrow()
	})
})

describe("npx mailwoman parse --benchmark <N> --degraded '<input>'", () => {
	test("emits the percentile report and exits 0", async () => {
		const { stdout } = await exec(
			process.execPath,
			[cliBin, "parse", "--benchmark", "10", "--degraded", "350 5th Ave, New York, NY 10118"],
			{ env: childEnv({ MAILWOMAN_TEST_MODE: "1" }) }
		)

		expect(stdout).toContain("iterations + 5 warmup")
		expect(stdout).toContain("stage")
		// The regression guard for the flag this file used to pass: if the encoder loads, the header
		// says so, and the run is neither deterministic nor fast.
		expect(stdout).toContain("classifier: none")
		expect(stdout).toContain("p50")
		expect(stdout).toContain("TOTAL")
		expect(stdout).toContain("normalize")
		expect(stdout).toContain("query-shape")
		expect(stdout).toContain("heap delta")
	}, 30_000)

	test("rejects --benchmark with --neural", async () => {
		let err: (Error & { stderr?: string; stdout?: string; code?: number }) | undefined

		try {
			await exec(process.execPath, [cliBin, "parse", "--benchmark", "5", "--neural", "hello world"])
		} catch (error) {
			err = error as Error & { stderr?: string; stdout?: string; code?: number }
		}

		expect(err).toBeDefined()
		// Ink renders the error to stdout (Text color=red), not stderr. Process exits 1 because the
		// useEffect-driven setError(...) → setImmediate(() => process.exit(1)) path fires.
		const combined = `${err?.stdout ?? ""}${err?.stderr ?? ""}`
		expect(combined).toMatch(/--benchmark requires the default runtime-pipeline path/)
	}, 30_000)
})
