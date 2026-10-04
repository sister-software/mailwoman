/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import {
	patternExports,
	patternExpresses,
	patternImports,
	rootPatternEntry,
	scopedFiles,
} from "#repo-health/checks/workspace-manifest"

const standard = (module: string) => ({
	types: `./out/${module}.d.ts`,
	node: `./lib/${module}.ts`,
	default: `./out/${module}.js`,
})

describe("patternExpresses", () => {
	test("accepts a standard entry whatever its key spells", () => {
		expect(patternExpresses(standard("paths"))).toBe(true)
		expect(patternExpresses(standard("address/layout"))).toBe(true)
		expect(patternExpresses(standard("sdk/index"))).toBe(true)
		expect(patternExpresses(standard("scripts/*"))).toBe(true)
	})

	test("rejects an entry the pattern cannot reproduce", () => {
		expect(patternExpresses("./styles.css")).toBe(false)
		expect(patternExpresses({ ...standard("map/Frame"), node: "./lib/map/Frame.tsx" })).toBe(false)

		expect(
			patternExpresses({
				types: "./out/a.d.ts",
				browser: "./out/a.browser.js",
				node: "./lib/a.ts",
				default: "./out/a.js",
			})
		).toBe(false)

		expect(patternExpresses({ ...standard("crypto/node"), default: "./out/crypto/browser.js" })).toBe(false)
	})
})

describe("patternExports", () => {
	test("keeps the root, non-code and .tsx entries and appends the pattern", () => {
		const exports = patternExports({
			"./package.json": "./package.json",
			".": standard("index"),
			"./styles.css": "./styles.css",
			"./paths": standard("paths"),
			"./sdk": standard("sdk/index"),
			"./map/Frame": { ...standard("map/Frame"), node: "./lib/map/Frame.tsx" },
		})

		expect(Object.keys(exports)).toEqual(["./package.json", ".", "./styles.css", "./map/Frame", "./*"])
		expect(exports["./*"]).toEqual(standard("*"))
	})
})

describe("extra source roots", () => {
	const inRoot = (module: string) => ({
		types: `./out/sdk/${module}.d.ts`,
		node: `./sdk/${module}.ts`,
		default: `./out/sdk/${module}.js`,
	})

	test("a root's pattern expresses its modules only when the root is declared", () => {
		expect(patternExpresses(inRoot("cells"), ["sdk"])).toBe(true)
		expect(patternExpresses(inRoot("cells"))).toBe(false)
	})

	test("adds the root's pattern ahead of the lib/ pattern and its import key ahead of #*", () => {
		const exports = patternExports({ ".": standard("index"), "./sdk/cells": inRoot("cells") }, ["sdk"])

		expect(Object.keys(exports)).toEqual([".", "./sdk/*", "./*"])
		expect(exports["./sdk/*"]).toEqual(rootPatternEntry("sdk"))

		const imports = patternImports({ "#*": standard("*") }, ["sdk"])

		expect(Object.keys(imports)).toEqual(["#sdk/*", "#*"])
	})

	test("adds the root's files glob before the test negations", () => {
		expect(scopedFiles(["out/**/*.js", "lib/**/*.ts", "lib/**/*.tsx", "!**/*.test.ts"], ["sdk"])).toEqual([
			"out/**/*.js",
			"lib/**/*.ts",
			"lib/**/*.tsx",
			"!**/*.test.ts",
			"sdk/**/*.ts",
			"!**/*.test.tsx",
		])
	})
})

describe("scopedFiles", () => {
	test("replaces the unscoped TypeScript globs with lib/ globs at the first one's position", () => {
		expect(
			scopedFiles([
				"out/**/*.js",
				"README.md",
				"*.ts",
				"*.tsx",
				"**/*.ts",
				"**/*.tsx",
				"!*.test.ts",
				"!*.test.tsx",
				"!**/*.test.ts",
				"!**/*.test.tsx",
				"!test/**",
				"data/**",
			])
		).toEqual(["out/**/*.js", "README.md", "lib/**/*.ts", "lib/**/*.tsx", "!**/*.test.ts", "!**/*.test.tsx", "data/**"])
	})

	test("leaves a scoped list unchanged", () => {
		const files = ["out/", "lib/**/*.ts", "lib/**/*.tsx", "!**/*.test.ts", "!**/*.test.tsx"]

		expect(scopedFiles(files)).toEqual(files)
	})

	test("appends the test negations a list lacks", () => {
		expect(scopedFiles(["out/", "*.ts", "!*.test.ts", "!test/**"])).toEqual([
			"out/",
			"lib/**/*.ts",
			"lib/**/*.tsx",
			"!**/*.test.ts",
			"!**/*.test.tsx",
		])
	})
})
