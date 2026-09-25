import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { mailwomanCLIPath } from "mailwoman/cli-kit/metadata"
import { $public } from "mailwoman/env"
import type { PathBuilderLike } from "path-ts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

const cliBin = await mailwomanCLIPath()

const ABSENT_LOCALE = "pt-BR"
const ABSENT_PACKAGE = "@mailwoman/neural-weights-pt-br"

let homeStub: TemporaryDirectory

let stubDir: TemporaryDirectory

beforeAll(async () => {
	homeStub = await temporaryDirectory("mailwoman-nohome-")
	stubDir = await temporaryDirectory("mailwoman-stub-weights-")

	await writeLocalTextFile("not a real onnx graph", stubDir.path("model.onnx"))
})

afterAll(() => {
	homeStub[Symbol.asyncDispose]()
	stubDir[Symbol.asyncDispose]()
})

function absentEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return childEnv({ HOME: homeStub.path.toString(), NODE_NO_WARNINGS: "1", ...extra })
}

async function runCLI(
	args: readonly PathBuilderLike[],
	env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await runFile("node", [cliBin, ...args], { env, maxBuffer: 8 * 1024 * 1024 })

		return { stdout, stderr, code: 0 }
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; code?: number }

		return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 }
	}
}

function parseStdoutJSON(stdout: string): unknown {
	const cleaned = stdout.replaceAll(/\[[0-9;]*[a-zA-Z]/gu, "").trim()
	const start = cleaned.search(/[{[]/u)

	if (start < 0) throw new Error(`No JSON payload in stdout:\n${stdout}`)
	const opener = cleaned[start]
	const closer = opener === "{" ? "}" : "]"

	return parseJSONStrict(cleaned.slice(start, cleaned.lastIndexOf(closer) + 1))
}

const ADDRESS = "350 5th Ave, New York, NY 10118"

describe("Loud weights fallback — weights ABSENT (non-interactive / piped stdin)", () => {
	test("plain parse: warns on stderr, still emits parseable JSON on stdout, exit 0", async () => {
		const { stdout, stderr, code } = await runCLI(["parse", "--locale", ABSENT_LOCALE, ADDRESS], absentEnv())

		expect(code).toBe(0)
		expect(stderr).toContain("neural weights not found")
		expect(stderr).toContain(ABSENT_PACKAGE)

		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed).toBeTypeOf("object")
		expect(parsed["postcode"]).toBe("10118")
	}, 30_000)

	test("--debug: the previously-SILENT resolve/debug path now warns on stderr, PipelineResult on stdout, exit 0", async () => {
		const { stdout, stderr, code } = await runCLI(["parse", "--locale", ABSENT_LOCALE, "--debug", ADDRESS], absentEnv())

		expect(code).toBe(0)
		expect(stderr).toContain("neural weights not found")

		const result = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(result).toHaveProperty("input")
		expect(result).toHaveProperty("path")
		expect(result).toHaveProperty("tree")
		expect(result["input"]).toBe(ADDRESS)
	}, 30_000)

	test("--resolve (no WOF DB): the previously-SILENT path emits the weights warning to stderr", async () => {
		const { stderr } = await runCLI(
			["parse", "--locale", ABSENT_LOCALE, "--resolve", ADDRESS],
			absentEnv({ MAILWOMAN_WOF_DB: "" })
		)

		expect(stderr).toContain("neural weights not found")
	}, 30_000)

	test("stdout carries the machine payload ONLY — the notice never leaks off stderr", async () => {
		const { stdout, stderr } = await runCLI(["parse", "--locale", ABSENT_LOCALE, ADDRESS], absentEnv())

		expect(stdout).not.toContain("⚠")
		expect(stdout).not.toMatch(/neural weights/u)
		expect(stderr).toContain("⚠")

		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed).not.toHaveProperty("roots")
		expect(parsed).not.toHaveProperty("raw")
	}, 30_000)
})

describe("Loud weights fallback — weights LOAD error surfaced, not swallowed", () => {
	test("bad explicit --model/--tokenizer: the underlying load error is surfaced (distinct from 'not found'), exit 0", async () => {
		const modelPath = stubDir.path("model.onnx")
		const tokenizerPath = stubDir.path("does-not-exist-tokenizer.model")

		const { stdout, stderr, code } = await runCLI(
			["parse", "--model", modelPath, "--tokenizer", tokenizerPath, ADDRESS],
			absentEnv()
		)

		expect(code).toBe(0)

		expect(stderr).toContain("neural weights failed to load")
		expect(stderr).toContain(tokenizerPath)
		expect(stderr).not.toContain("neural weights not found")

		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed["postcode"]).toBe("10118")
	}, 30_000)
})

describe("— the interactive/declined degraded banner is unchanged (check)", () => {
	test("--degraded: the generic degraded banner still fires on stderr with output on stdout, exit 0", async () => {
		const { stdout, stderr, code } = await runCLI(["parse", "--degraded", ADDRESS], absentEnv())

		expect(code).toBe(0)
		expect(stderr).toContain("degraded parse: the neural encoder is not loaded")
		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed["postcode"]).toBe("10118")
	}, 30_000)

	test("--degraded with an explicit --model skips the encoder load", async () => {
		const { stdout, stderr, code } = await runCLI(
			["parse", "--degraded", "--model", stubDir.path("model.onnx"), ADDRESS],
			absentEnv()
		)

		expect(code).toBe(0)
		expect(stderr).toContain("degraded parse: the neural encoder is not loaded")
		expect(stderr).not.toContain("neural weights failed to load")
		const parsed = parseStdoutJSON(stdout) as Record<string, unknown>
		expect(parsed["postcode"]).toBe("10118")
	}, 30_000)

	test("--degraded with --neural is rejected", async () => {
		const { stdout, stderr, code } = await runCLI(["parse", "--degraded", "--neural", ADDRESS], absentEnv())

		expect(code).not.toBe(0)
		// Ink wraps the error to the terminal width, so the check ignores line breaks.
		expect(`${stdout}${stderr}`.replaceAll(/\s+/g, " ")).toContain("cannot be combined with --policy or --neural")
	}, 30_000)
})

const DEFAULT_WOF_PATH = wofDatabasePath("whosonfirst-data-admin-us-latest.db")
const wofPath = $public.MAILWOMAN_WOF_DB || DEFAULT_WOF_PATH.toString()
const hasWOFDB = await pathExists(wofPath)

describe.skipIf(!hasWOFDB)("Loud weights fallback — --resolve degraded end-to-end (WOF DB present)", () => {
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
