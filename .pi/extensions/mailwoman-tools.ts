/**
 * Mailwoman Tools Extension
 *
 * Two Pi custom tools for the mailwoman monorepo:
 *
 * 1. Check_release — validates release readiness
 * 2. Parse_address — runs mailwoman CLI parser on an address string
 *
 * Pattern from: dynamic-tools.ts (tool registration)
 */

import { lstatSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const PROJECT_ROOT = process.cwd()

// ---- Shared constants ----
const WEIGHTS_FILES = [
	"neural-weights-en-us/model.onnx",
	"neural-weights-en-us/tokenizer.model",
	"neural-weights-fr-fr/model.onnx",
	"neural-weights-fr-fr/tokenizer.model",
]

interface ReleaseConfig {
	version: string
}

interface CheckReleaseResult {
	passed: boolean
	issues: string[]
	version: string
	weightsPresent: string[]
	weightsMissing: string[]
	weightsSymlinked: string[]
	gitClean: boolean
	compileSuccess: boolean | null
	testSuccess: boolean | null
}

// ---- Helpers ----

function parseReleaseConfig(): ReleaseConfig | null {
	try {
		const raw = readFileSync(resolve(PROJECT_ROOT, "release.config.json"), "utf-8")

		return JSON.parse(raw) as ReleaseConfig
	} catch {
		return null
	}
}

function checkWeights(): {
	present: string[]
	missing: string[]
	symlinked: string[]
} {
	const present: string[] = []
	const missing: string[] = []
	const symlinked: string[] = []

	for (const rel of WEIGHTS_FILES) {
		const abs = resolve(PROJECT_ROOT, rel)

		try {
			const stat = lstatSync(abs)

			if (stat.isSymbolicLink()) {
				symlinked.push(rel)
			} else if (stat.isFile()) {
				present.push(rel)
			} else {
				missing.push(rel)
			}
		} catch {
			missing.push(rel)
		}
	}

	return { present, missing, symlinked }
}

// ---- Extension ----

export default function (pi: ExtensionAPI) {
	// ----- Tool 1: check_release -----
	pi.registerTool({
		name: "check_release",
		label: "Check Release",
		description:
			"Validate release readiness for the mailwoman monorepo: checks version config, weights files (real files not symlinks), git cleanliness, compile success, and test results.",
		promptSnippet: "Validate mailwoman release readiness (version, weights, git, compile, tests)",
		promptGuidelines: [
			"Use check_release before running yarn release or npm publish in the mailwoman monorepo to validate release readiness.",
			"Use check_release when the user asks if the repo is ready to release or wants a pre-flight check.",
		],
		parameters: Type.Object({
			skipTests: Type.Optional(
				Type.Boolean({
					description:
						"Skip running yarn ci:test (default: false). Tests are slow; use when you only need lighter checks.",
				})
			),
			skipCompile: Type.Optional(
				Type.Boolean({
					description: "Skip running yarn compile (default: false). Skip if you know it was already compiled.",
				})
			),
		}),
		async execute(toolCallId, params, signal, onUpdate) {
			const result: CheckReleaseResult = {
				passed: true,
				issues: [],
				version: "unknown",
				weightsPresent: [],
				weightsMissing: [],
				weightsSymlinked: [],
				gitClean: false,
				compileSuccess: null,
				testSuccess: null,
			}

			// --- Step 1: Version from release.config.json ---
			onUpdate?.({
				content: [{ type: "text", text: "Checking release.config.json version..." }],
			})

			const releaseConfig = parseReleaseConfig()

			if (!releaseConfig) {
				result.passed = false
				result.issues.push("release.config.json not found or unparseable")
			} else {
				result.version = releaseConfig.version

				if (!releaseConfig.version) {
					result.passed = false
					result.issues.push("release.config.json missing version field")
				}
			}

			// --- Step 2: Weights existence (real files, not symlinks) ---
			onUpdate?.({
				content: [{ type: "text", text: "Checking weights files..." }],
			})

			const weights = checkWeights()
			result.weightsPresent = weights.present
			result.weightsMissing = weights.missing
			result.weightsSymlinked = weights.symlinked

			const skipWeights = process.env.MAILWOMAN_SKIP_WEIGHTS_COPY || process.env.MAILWOMAN_SKIP_WEIGHTS

			if (skipWeights) {
				result.issues.push(`Weights checks skipped (MAILWOMAN_SKIP_WEIGHTS_COPY/MAILWOMAN_SKIP_WEIGHTS set)`)
			} else {
				if (weights.missing.length > 0) {
					result.passed = false
					result.issues.push(`Missing weights: ${weights.missing.join(", ")}`)
				}

				if (weights.symlinked.length > 0) {
					result.passed = false
					result.issues.push(`Symlinked weights (will break npm publish): ${weights.symlinked.join(", ")}`)
				}
			}

			// --- Step 3: Git cleanliness ---
			onUpdate?.({
				content: [{ type: "text", text: "Checking git status..." }],
			})

			const gitResult = await pi.exec("git", ["status", "--porcelain"], {
				signal,
				timeout: 10_000,
			})

			if (gitResult.code !== 0) {
				result.passed = false
				result.issues.push(`Git status failed (code ${gitResult.code}): ${gitResult.stderr.trim() || "unknown error"}`)
			} else {
				const dirty = gitResult.stdout.trim()
				result.gitClean = dirty.length === 0

				if (!result.gitClean) {
					result.passed = false
					const fileCount = dirty.split("\n").filter(Boolean).length
					result.issues.push(
						`Git working directory not clean (${fileCount} uncommitted file${fileCount === 1 ? "" : "s"})`
					)
				}
			}

			// --- Step 4: Compile (yarn compile) ---
			if (!params.skipCompile) {
				onUpdate?.({
					content: [{ type: "text", text: "Running yarn compile..." }],
				})

				const compileResult = await pi.exec("yarn", ["compile"], {
					signal,
					timeout: 120_000,
				})

				result.compileSuccess = compileResult.code === 0

				if (!result.compileSuccess) {
					result.passed = false
					result.issues.push(`yarn compile failed (code ${compileResult.code})`)
				}
			} else {
				result.compileSuccess = null
			}

			// --- Step 5: Tests (yarn ci:test) ---
			if (!params.skipTests) {
				onUpdate?.({
					content: [{ type: "text", text: "Running yarn ci:test..." }],
				})

				const testResult = await pi.exec("yarn", ["ci:test"], {
					signal,
					timeout: 300_000,
				})

				result.testSuccess = testResult.code === 0

				if (!result.testSuccess) {
					result.passed = false
					result.issues.push(`yarn ci:test failed (code ${testResult.code})`)
				}
			} else {
				result.testSuccess = null
			}

			// Build summary text
			const lines: string[] = []
			lines.push(result.passed ? "✅ Release check PASSED" : "❌ Release check FAILED")
			lines.push("")
			lines.push(`Version: ${result.version}`)
			lines.push(
				`Weights: ${result.weightsPresent.length} present, ${result.weightsMissing.length} missing, ${result.weightsSymlinked.length} symlinked`
			)

			if (result.weightsMissing.length > 0) {
				lines.push(`  Missing: ${result.weightsMissing.join(", ")}`)
			}

			if (result.weightsSymlinked.length > 0) {
				lines.push(`  Symlinked: ${result.weightsSymlinked.join(", ")}`)
			}
			lines.push(`Git clean: ${result.gitClean ? "yes" : "no"}`)
			lines.push(`Compile: ${result.compileSuccess === null ? "skipped" : result.compileSuccess ? "passed" : "failed"}`)
			lines.push(`Tests: ${result.testSuccess === null ? "skipped" : result.testSuccess ? "passed" : "failed"}`)

			if (result.issues.length > 0) {
				lines.push("")
				lines.push("Issues:")

				for (const issue of result.issues) {
					lines.push(`  - ${issue}`)
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: result,
			}
		},
	})

	// ----- Tool 2: parse_address -----
	pi.registerTool({
		name: "parse_address",
		label: "Parse Address",
		description:
			"Parse a postal address string using mailwoman's parser. Returns a component breakdown (house_number, street, locality, region, postcode, etc.).",
		promptSnippet: "Parse a postal address string into components (house_number, street, locality, region, postcode)",
		promptGuidelines: [
			"Use parse_address when the user asks to parse, analyze, or break down a postal address.",
			"Use parse_address to verify how mailwoman interprets a specific address string.",
		],
		parameters: Type.Object({
			address: Type.String({
				description: "Postal address string to parse (e.g. '1600 Amphitheatre Parkway, Mountain View, CA 94043')",
			}),
			locale: Type.Optional(
				Type.String({
					description: "Locale tag matching a weights package (en-US, fr-FR). Default: en-US.",
				})
			),
			defaultCountry: Type.Optional(
				Type.String({
					description: "ISO-3166 country to scope the WOF resolver (e.g. 'US'). Pass 'none' to disable.",
				})
			),
		}),
		async execute(_toolCallId, params, signal) {
			const args = ["mailwoman/out/cli.js", "parse"]

			if (params.locale) {
				args.push("--locale", params.locale)
			}

			if (params.defaultCountry !== undefined) {
				args.push("--default-country", params.defaultCountry)
			}
			args.push(params.address)

			const result = await pi.exec("node", args, {
				signal,
				timeout: 60_000,
			})

			if (result.code !== 0) {
				const errorOutput = result.stderr.trim() || result.stdout.trim() || "unknown error"

				return {
					content: [
						{
							type: "text",
							text: `Parse failed (code ${result.code}): ${errorOutput}`,
						},
					],
					details: {
						error: errorOutput,
						code: result.code,
						killed: result.killed,
					},
				}
			}

			// Strip stderr noise (SQLite experimental warning, etc.) from the output
			const stdout = result.stdout.trim()

			let parsed: unknown

			try {
				parsed = JSON.parse(stdout)
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Parse produced non-JSON output:\n${stdout.slice(0, 2000)}`,
						},
					],
					details: { rawOutput: stdout },
				}
			}

			// Pretty-print for LLM readability, with 50KB truncation
			const pretty = JSON.stringify(parsed, null, 2)
			const maxBytes = 50_000
			const truncated =
				pretty.length > maxBytes
					? pretty.slice(0, maxBytes) + `\n\n[Truncated at 50KB — ${pretty.length} bytes total]`
					: pretty

			const isArray = Array.isArray(parsed)
			let summary: string

			if (isArray) {
				const n = (parsed as unknown[]).length
				summary = `${n} candidate${n !== 1 ? "s" : ""} returned`
			} else if (typeof parsed === "object" && parsed !== null) {
				const n = Object.keys(parsed as Record<string, unknown>).length
				summary = `${n} component${n !== 1 ? "s" : ""} resolved`
			} else {
				summary = "Parser output"
			}

			return {
				content: [
					{
						type: "text",
						text: `${summary}:\n${truncated}`,
					},
				],
				details: { parsed, truncated: truncated.length < pretty.length },
			}
		},
	})
}
