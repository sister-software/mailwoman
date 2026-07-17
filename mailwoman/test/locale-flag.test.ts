/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI `--locale` flag validation. Confirms the parse command's options schema accepts BCP-47 tags
 *   and rejects bad input, and that a model-independent fast-path input runs through the compiled CLI.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { options as parseOptions } from "../commands/parse.tsx"

const exec = promisify(execFile)
const cliBin = repoRootPath("mailwoman", "out", "cli.js")

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

	test("locale is optional", () => {
		expect(() => parseOptions.parse({})).not.toThrow()
	})
})

describe("npx mailwoman parse '<input>' (default — runtime pipeline)", () => {
	test("exits 0 on a bare US ZIP+4 via fast-path (postcode_only)", async () => {
		const { stdout } = await exec(process.execPath, [cliBin, "parse", "10118-1234"])
		// Fast-path for unambiguous US ZIP+4 emits a postcode root from QueryShape; no model needed.
		expect(stdout).toContain("postcode")
		expect(stdout).toContain("10118-1234")
	}, 20_000)
})
