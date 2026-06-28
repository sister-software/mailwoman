/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI `--locale` flag validation. Confirms each command's options schema accepts BCP-47 tags and
 *   rejects bad input, and that running the compiled CLI with `--locale en-US "..."` exits
 *   successfully.
 */

import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, test } from "vitest"

import { options as debugOptions } from "../commands/debug.js"
import { options as parseOptions } from "../commands/parse.js"

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(import.meta.url), "../..")
const cliBin = resolve(repoRoot, "out", "cli.js")

describe("--locale schema validation", () => {
	test("parse command accepts en-US, fr-FR, en (any BCP-47 tag with optional region)", () => {
		expect(() => parseOptions.parse({ locale: "en-US" })).not.toThrow()
		expect(() => parseOptions.parse({ locale: "fr-FR" })).not.toThrow()
		expect(() => parseOptions.parse({ locale: "ja-JP" })).not.toThrow()
		expect(() => parseOptions.parse({ locale: "en" })).not.toThrow()
	})

	test("parse command rejects malformed locale tags", () => {
		expect(() => parseOptions.parse({ locale: "english" })).toThrow()
		expect(() => parseOptions.parse({ locale: "EN-us" })).toThrow()
		expect(() => parseOptions.parse({ locale: "en_US" })).toThrow()
	})

	test("locale is optional on both commands", () => {
		expect(() => parseOptions.parse({})).not.toThrow()
		expect(() => debugOptions.parse({})).not.toThrow()
	})

	test("debug command accepts the same BCP-47 set", () => {
		expect(() => debugOptions.parse({ locale: "en-US" })).not.toThrow()
		expect(() => debugOptions.parse({ locale: "fr-FR" })).not.toThrow()
		expect(() => debugOptions.parse({ locale: "english" })).toThrow()
	})
})

describe("npx mailwoman parse --isolated --locale <bcp47> '<input>' (legacy rule-only path)", () => {
	// The default CLI path is now the runtime pipeline (which routes through the neural classifier
	// when weights are available). --isolated forces the pre-pipeline rule-only path so this suite
	// stays deterministic + model-independent.
	test("exits 0 for en-US on the canonical US sample", async () => {
		const { stdout } = await exec(process.execPath, [
			cliBin,
			"parse",
			"--isolated",
			"--locale",
			"en-US",
			"Mt Tabor Park, 6220 SE Salmon St, Portland, OR 97215, USA",
		])
		expect(stdout).toContain("Portland")
		expect(stdout).toContain("97215")
	}, 20_000)

	test("exits 0 for fr-FR on a French sample", async () => {
		const { stdout } = await exec(process.execPath, [
			cliBin,
			"parse",
			"--isolated",
			"--locale",
			"fr-FR",
			"8 rue de la République, 75008 Paris, France",
		])
		expect(stdout).toContain("Paris")
		expect(stdout).toContain("75008")
	}, 20_000)

	test("matches no-locale behavior on en-US (Phase 0 invariant: locale does not change output)", async () => {
		const sample = "Mt Tabor Park, 6220 SE Salmon St, Portland, OR 97215, USA"
		const [withLocale, withoutLocale] = await Promise.all([
			exec(process.execPath, [cliBin, "parse", "--isolated", "--locale", "en-US", sample]),
			exec(process.execPath, [cliBin, "parse", "--isolated", sample]),
		])
		// Strip ANSI escapes and ink spinner frames; compare the JSON payload only.
		const ansi = /\[[0-9;]*[a-zA-Z]/gu
		const json = (stdout: string) => {
			const clean = stdout.replace(ansi, "")
			const jsonStart = clean.indexOf("[\n")

			return clean.slice(jsonStart)
		}
		expect(json(withLocale.stdout)).toEqual(json(withoutLocale.stdout))
	}, 30_000)
})

describe("npx mailwoman parse '<input>' (default — runtime pipeline)", () => {
	// The default CLI path runs the runtime pipeline; falls back to the rule-only parser when
	// neural weights aren't installed.
	test("exits 0 on a structured US address (non-empty output)", async () => {
		const { stdout } = await exec(process.execPath, [
			cliBin,
			"parse",
			"Mt Tabor Park, 6220 SE Salmon St, Portland, OR 97215, USA",
		])
		// Output shape is model-dependent (pipeline + neural vs rule-only fallback) — we only
		// assert non-emptiness here. Per-model assertions live in the --isolated suite.
		expect(stdout.trim().length).toBeGreaterThan(2)
	}, 20_000)

	test("exits 0 on a bare US ZIP+4 via fast-path (postcode_only)", async () => {
		const { stdout } = await exec(process.execPath, [cliBin, "parse", "10118-1234"])
		// Fast-path for unambiguous US ZIP+4 emits a postcode root from QueryShape; no model needed.
		expect(stdout).toContain("postcode")
		expect(stdout).toContain("10118-1234")
	}, 20_000)
})
