/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1108 — the CLI's weights fallback must be LOUD, never silent, while KEEPING the encoder-less
 *   structural fallback so `npx mailwoman parse …` quick demos still produce output.
 *
 *   These integration tests drive the compiled CLI (`mailwoman/out/cli.js`) with weights forced ABSENT
 *   (a locale with no weights workspace package + an empty $HOME so the user weights cache is empty too)
 *   or a bad explicit `--model`/`--tokenizer` (the corrupt/partial-bundle surrogate — a load error that
 *   `resolveWeights` raises deterministically, without needing a real onnx graph). Each asserts that:
 *
 *   1. a warning lands on STDERR (never STDOUT — piped stdout parsing must stay clean), and
 *   2. degraded structural output is STILL produced on STDOUT with exit 0 (the fallback is kept, not
 *      turned into a hard-fail), and
 *   3. weights-ABSENT ("not found — install …") is distinguished from a weights LOAD error ("failed to
 *      load — Encoder error: …", the underlying cause surfaced rather than swallowed).
 *
 *   The two silence points the audit named: (a) `tryLoadNeural`'s bare `try/catch` returned undefined
 *   with no log; (b) the `--resolve`/`--debug` paths bypassed the degraded banner entirely. Both are
 *   covered below.
 */

import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { $public } from "@mailwoman/core/env"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

const exec = promisify(execFile)
const cliBin = repoRootPath("mailwoman", "out", "cli.js")

/**
 * A locale with no `@mailwoman/neural-weights-*` workspace package — resolution can never succeed.
 *
 * Was `de-DE` until 2026-08-02, when campaign R9 shipped `@mailwoman/neural-weights-de-de` and made the "absent" locale
 * resolvable. Every assertion here inverted at once: the CLI stopped warning because it found real weights, and
 * `expected '' to contain 'neural weights not found'` is what that looks like. `pt-BR` has no carrier package today; if
 * one ever ships, this breaks the same way and wants the same one-line move.
 */
const ABSENT_LOCALE = "pt-BR"
const ABSENT_PACKAGE = "@mailwoman/neural-weights-pt-br"

/**
 * An empty $HOME so the user weights cache (`~/.cache/mailwoman/weights`) is empty for the child too.
 */
let homeStub: string
/**
 * A dir holding a stub model.onnx for the corrupt/partial-load case.
 */
let stubDir: string

beforeAll(() => {
	homeStub = mkdtempSync(join(tmpdir(), "mailwoman-nohome-"))
	stubDir = mkdtempSync(join(tmpdir(), "mailwoman-stub-weights-"))
	// A present-but-not-a-model file so `resolveWeights`'s existsSync(modelPath) passes and the failure
	// lands on the (deliberately absent) tokenizer path — a deterministic load error, no onnx runtime needed.
	writeFileSync(join(stubDir, "model.onnx"), "not a real onnx graph")
})

afterAll(() => {
	rmSync(homeStub, { recursive: true, force: true })
	rmSync(stubDir, { recursive: true, force: true })
})

/**
 * Child env with weights forced absent: empty $HOME + quiet node.
 */
function absentEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return childEnv({ HOME: homeStub, NODE_NO_WARNINGS: "1", ...extra })
}

/**
 * Run the CLI, capturing stdout/stderr/exit whether it exits 0 or non-zero (execFile rejects on non-zero).
 */
async function runCLI(
	args: readonly string[],
	env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await exec("node", [cliBin, ...args], { env, maxBuffer: 8 * 1024 * 1024 })

		return { stdout, stderr, code: 0 }
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; code?: number }

		return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 }
	}
}

/**
 * Strip ANSI/ink-spinner noise and parse the JSON payload (object or array) out of CLI stdout.
 */
function parseStdoutJSON(stdout: string): unknown {
	const cleaned = stdout.replaceAll(/\[[0-9;]*[a-zA-Z]/gu, "").trim()
	const start = cleaned.search(/[{[]/u)

	if (start < 0) throw new Error(`No JSON payload in stdout:\n${stdout}`)
	const opener = cleaned[start]
	const closer = opener === "{" ? "}" : "]"

	return parseJSONStrict(cleaned.slice(start, cleaned.lastIndexOf(closer) + 1))
}

const ADDRESS = "350 5th Ave, New York, NY 10118"

describe("#1108 loud weights fallback — weights ABSENT (non-interactive / piped stdin)", () => {
	test("plain parse: warns on stderr, still emits parseable JSON on stdout, exit 0", async () => {
		const { stdout, stderr, code } = await runCLI(["parse", "--locale", ABSENT_LOCALE, ADDRESS], absentEnv())

		expect(code).toBe(0)
		expect(stderr).toContain("neural weights not found")
		expect(stderr).toContain(ABSENT_PACKAGE)
		// The encoder-less structural fallback still produced output — not silent, not empty.
		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed).toBeTypeOf("object")
		expect(parsed["postcode"]).toBe("10118")
	}, 30_000)

	test("--debug: the previously-SILENT resolve/debug path now warns on stderr, PipelineResult on stdout, exit 0", async () => {
		const { stdout, stderr, code } = await runCLI(["parse", "--locale", ABSENT_LOCALE, "--debug", ADDRESS], absentEnv())

		expect(code).toBe(0)
		expect(stderr).toContain("neural weights not found")
		// Silence point 2: --debug used to fall through with no notice. It must now be loud.
		const result = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(result).toHaveProperty("input")
		expect(result).toHaveProperty("path")
		expect(result).toHaveProperty("tree")
		expect(result["input"]).toBe(ADDRESS)
	}, 30_000)

	test("--resolve (no WOF DB): the previously-SILENT path emits the weights warning to stderr", async () => {
		// Without a resolver DB the command exits non-zero on the DB requirement, but the fix is proven by
		// the weights warning being present at all on the --resolve path (it was fully silent before #1108).
		const { stderr } = await runCLI(
			["parse", "--locale", ABSENT_LOCALE, "--resolve", ADDRESS],
			absentEnv({ MAILWOMAN_WOF_DB: "" })
		)

		expect(stderr).toContain("neural weights not found")
	}, 30_000)

	test("stdout carries the machine payload ONLY — the notice never leaks off stderr", async () => {
		const { stdout, stderr } = await runCLI(["parse", "--locale", ABSENT_LOCALE, ADDRESS], absentEnv())

		// The ⚠ notice must be stderr-only so piped stdout parsing is byte-clean.
		expect(stdout).not.toContain("⚠")
		expect(stdout).not.toMatch(/neural weights/u)
		expect(stderr).toContain("⚠")
		// And the stdout projection is unchanged: libpostal-flat (no tree `roots`/`raw` leak).
		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed).not.toHaveProperty("roots")
		expect(parsed).not.toHaveProperty("raw")
	}, 30_000)
})

describe("#1108 loud weights fallback — weights LOAD error surfaced, not swallowed", () => {
	test("bad explicit --model/--tokenizer: the underlying load error is surfaced (distinct from 'not found'), exit 0", async () => {
		const modelPath = join(stubDir, "model.onnx")
		const tokenizerPath = join(stubDir, "does-not-exist-tokenizer.model")

		const { stdout, stderr, code } = await runCLI(
			["parse", "--model", modelPath, "--tokenizer", tokenizerPath, ADDRESS],
			absentEnv()
		)

		expect(code).toBe(0)
		// Corrupt/partial → surface the cause, do NOT mislabel it "not installed".
		expect(stderr).toContain("neural weights failed to load")
		expect(stderr).toContain(tokenizerPath)
		expect(stderr).not.toContain("neural weights not found")
		// Fallback still kept: structural output on stdout.
		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed["postcode"]).toBe("10118")
	}, 30_000)
})

describe("#1108 — the interactive/declined degraded banner is unchanged (regression guard)", () => {
	test("--degraded: the generic degraded banner still fires on stderr with output on stdout, exit 0", async () => {
		// `--degraded` drives the guard's `declined` outcome — the same path an interactive "n" reaches.
		// This path never attempts a load (so no absent/corrupt warning); its banner must remain intact.
		const { stdout, stderr, code } = await runCLI(["parse", "--degraded", ADDRESS], absentEnv())

		expect(code).toBe(0)
		expect(stderr).toContain("degraded parse: the neural encoder is not loaded")
		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed["postcode"]).toBe("10118")
	}, 30_000)
})

// End-to-end --resolve degraded path (exit 0 with a real resolver) — gated on a WOF SQLite distribution,
// mirroring resolve-flag.test.ts. Runs only where a WOF DB is on disk; proves the warning + degraded
// output + exit 0 combination the audit's test (1) calls for on the full --resolve path.
const DEFAULT_WOF_PATH = String(dataRootPath("wof", "whosonfirst-data-admin-us-latest.db"))
const wofPath = $public.MAILWOMAN_WOF_DB || DEFAULT_WOF_PATH
const hasWOFDb = existsSync(wofPath)

describe.skipIf(!hasWOFDb)("#1108 loud weights fallback — --resolve degraded end-to-end (WOF DB present)", () => {
	test("missing weights + --resolve: warns on stderr, resolver-decorated output on stdout, exit 0", async () => {
		const { stdout, stderr, code } = await runCLI(
			["parse", "--locale", ABSENT_LOCALE, "--resolve", "--resolve-db", wofPath, ADDRESS],
			absentEnv({ MAILWOMAN_WOF_DB: wofPath })
		)

		expect(code).toBe(0)
		expect(stderr).toContain("neural weights not found")
		expect(stdout.trim().length).toBeGreaterThan(0)
	}, 60_000)
})
