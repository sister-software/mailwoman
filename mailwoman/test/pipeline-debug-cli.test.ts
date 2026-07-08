/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI integration test for `parse --debug` in the runtime-pipeline default mode.
 *
 *   When `--debug` runs against the pipeline path, the CLI emits a serialized `PipelineResult` —
 *   normalized + queryShape + locale + kind + path + timing + tree. This is the new operator-facing
 *   surface for diagnosing which stage produced which output. The test exercises the JSON shape
 *   without requiring a real model file (the pipeline falls back to the rule-only path when neural
 *   weights are absent + emits a tree from that).
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { childEnv, repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

const exec = promisify(execFile)
const cliBin = repoRootPath("mailwoman", "out", "cli.js")

/** Strip ANSI escapes + ink spinner frames; isolate the JSON payload. */
function extractJson(stdout: string): unknown {
	const ansi = /\[[0-9;]*[a-zA-Z]/gu
	const cleaned = stdout.replace(ansi, "").trim()
	// Find the outermost JSON object (debug mode emits an object — non-debug emits an array).
	const objStart = cleaned.indexOf("{")
	const objEnd = cleaned.lastIndexOf("}")

	if (objStart < 0 || objEnd < objStart) {
		throw new Error(`No JSON object in stdout:\n${stdout}`)
	}

	return JSON.parse(cleaned.slice(objStart, objEnd + 1))
}

describe("parse --debug (runtime pipeline)", () => {
	test("US ZIP+4 fast-path emits PipelineResult with path='fast-path' + timing + tree", async () => {
		// Bare US ZIP+4 hits the fast-path (postcode_only kind, unambiguous us_zip4 hit). Doesn't
		// require neural weights — the fast-path tree is built from QueryShape.
		const { stdout } = await exec(process.execPath, [cliBin, "parse", "--debug", "10118-1234"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})
		const result = extractJson(stdout) as Record<string, unknown>

		// Shape: every PipelineResult key is present.
		expect(result).toHaveProperty("input")
		expect(result).toHaveProperty("normalized")
		expect(result).toHaveProperty("queryShape")
		expect(result).toHaveProperty("locale")
		expect(result).toHaveProperty("kind")
		expect(result).toHaveProperty("path")
		expect(result).toHaveProperty("timing")
		expect(result).toHaveProperty("tree")

		// Specific assertions.
		expect(result["input"]).toBe("10118-1234")
		expect(result["path"]).toBe("fast-path")

		const kind = result["kind"] as Record<string, unknown>
		expect(kind["kind"]).toBe("postcode_only")

		const timing = result["timing"] as Record<string, number>
		expect(timing["normalize"]).toBeGreaterThanOrEqual(0)
		expect(timing["query-shape"]).toBeGreaterThanOrEqual(0)
		expect(timing["kind-classifier"]).toBeGreaterThanOrEqual(0)
		// Fast-path skips token-classify.
		expect(timing["token-classify"]).toBeUndefined()
	}, 20_000)

	test("locality_only fast-path identifies single-word inputs", async () => {
		const { stdout } = await exec(process.execPath, [cliBin, "parse", "--debug", "Paris"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})
		const result = extractJson(stdout) as Record<string, unknown>
		const kind = result["kind"] as Record<string, unknown>
		expect(kind["kind"]).toBe("locality_only")
	}, 20_000)

	test("queryShape carries the detected known-format hit for postcode inputs", async () => {
		const { stdout } = await exec(process.execPath, [cliBin, "parse", "--debug", "10118-1234"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})
		const result = extractJson(stdout) as Record<string, unknown>
		const shape = result["queryShape"] as Record<string, unknown>
		const formats = shape["knownFormats"] as Array<Record<string, unknown>>
		expect(formats.some((f) => f["format"] === "us_zip4")).toBe(true)
	}, 20_000)

	test("normalize records the offsetMap so consumers can map spans back to raw", async () => {
		const { stdout } = await exec(process.execPath, [cliBin, "parse", "--debug", "  Paris  "], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})
		const result = extractJson(stdout) as Record<string, unknown>
		const normalized = result["normalized"] as Record<string, unknown>
		expect(normalized["normalized"]).toBe("Paris")
		expect(normalized["raw"]).toBe("  Paris  ")
		// offsetMap[0] should point at 'P' in raw — index 2 (after the leading two spaces).
		const offsetMap = normalized["offsetMap"] as number[]
		expect(offsetMap[0]).toBe(2)
	}, 20_000)
})
