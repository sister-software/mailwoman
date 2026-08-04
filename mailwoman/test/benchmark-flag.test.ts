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
import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"
import { ZodError } from "zod"

import { options as parseOptions } from "../commands/parse.tsx"

const exec = promisify(execFile)
const cliBin = repoRootPath("mailwoman", "out", "cli.js")

describe("--benchmark schema", () => {
	test("accepts integer in [1, 10000]", () => {
		expect(() => parseOptions.parse({ benchmark: 1 })).not.toThrow()
		expect(() => parseOptions.parse({ benchmark: 100 })).not.toThrow()
		expect(() => parseOptions.parse({ benchmark: 10_000 })).not.toThrow()
	})

	test("coerces numeric strings", () => {
		const parsed = parseOptions.parse({ benchmark: "50" } as unknown as Record<string, unknown>)
		expect(parsed.benchmark).toBe(50)
	})

	test("rejects out-of-range values", () => {
		expect(() => parseOptions.parse({ benchmark: 0 })).toThrow(ZodError)
		expect(() => parseOptions.parse({ benchmark: -1 })).toThrow(ZodError)
		expect(() => parseOptions.parse({ benchmark: 10_001 })).toThrow(ZodError)
	})

	test("rejects non-integers", () => {
		expect(() => parseOptions.parse({ benchmark: 1.5 })).toThrow(ZodError)
	})

	test("benchmark is optional", () => {
		expect(() => parseOptions.parse({})).not.toThrow()
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
