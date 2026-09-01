/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI `--locale` flag validation. Confirms the parse command's options schema accepts BCP-47 tags
 *   and rejects bad input, and that a model-independent fast-path input runs through the compiled CLI.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { parseCommand } from "mailwoman/cli-native/spec"
import { spec as parseSpec } from "mailwoman/commands/parse"
import { describe, expect, test } from "vitest"

const cliBin = workspacePath("mailwoman", "out", "cli.js")

describe("--locale validation", () => {
	test("parse command accepts en-US, fr-FR, en (any BCP-47 tag with optional region)", () => {
		for (const locale of ["en-US", "fr-FR", "ja-JP", "en"]) {
			expect(() => parseCommand(parseSpec, ["--locale", locale, "address"])).not.toThrow()
		}
	})

	test("parse command rejects malformed locale tags", () => {
		for (const locale of ["english", "EN-us", "en_US"]) {
			expect(() => parseCommand(parseSpec, ["--locale", locale, "address"])).toThrow(/locale/)
		}
	})

	test("locale is optional", () => {
		expect(() => parseCommand(parseSpec, ["address"])).not.toThrow()
	})
})

describe("npx mailwoman parse '<input>' (default — runtime pipeline)", () => {
	test("exits 0 on a bare US ZIP+4 via fast-path (postcode_only)", async () => {
		const { stdout } = await runFile(process.execPath, [cliBin, "parse", "10118-1234"])
		// Fast-path for unambiguous US ZIP+4 emits a postcode root from QueryShape; no model needed.
		expect(stdout).toContain("postcode")
		expect(stdout).toContain("10118-1234")
	}, 20_000)
})
