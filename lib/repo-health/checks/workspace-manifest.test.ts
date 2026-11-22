// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import {
	patternExports,
	patternExpresses,
	patternImports,
	rootPatternEntry,
	scopedFiles,
	workspaceExportsCheck,
	workspaceFilesCheck,
} from "#repo-health/checks/workspace-manifest"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

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

	test("keeps a pattern entry whose added platform condition resolves to the source", () => {
		const workerPattern = {
			types: "./out/*.d.ts",
			workerd: "./lib/*.ts",
			node: "./lib/*.ts",
			default: "./out/*.js",
		}

		expect(patternExports({ "./*": workerPattern })["./*"]).toEqual(workerPattern)
	})

	test("replaces a pattern entry whose added condition resolves elsewhere", () => {
		const exports = patternExports({ "./*": { ...standard("*"), workerd: "./worker/*.ts" } })

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

describe("the workspace manifest checks", () => {
	const MANIFEST = "packages/a/package.json"

	/**
	 * A tree with one workspace that compiles `lib/` and declares `manifest`.
	 */
	const compilingTree = (manifest: object) => ({
		"package.json": { name: "fixture", private: true, workspaces: ["packages/*"] },
		"packages/a/tsconfig.json": { compilerOptions: { rootDir: "./lib", outDir: "./out" } },
		[MANIFEST]: { name: "@fixture/a", ...manifest },
	})

	const listed = { ".": standard("index"), "./cells": standard("cells") }
	const unscoped = ["out/", "*.ts", "!*.test.ts"]

	test("workspace-exports reports a manifest that lists a module its pattern would express", async () => {
		await using context = await plantFixtureRepository(compilingTree({ exports: listed }))

		const diagnostics = await workspaceExportsCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual([MANIFEST])
		expect(diagnostics[0]!.details).toEqual(["./cells"])
	})

	test("workspace-exports accepts the map its fix writes", async () => {
		await using context = await plantFixtureRepository(compilingTree({ exports: patternExports(listed) }))

		await expect(workspaceExportsCheck.run(context)).resolves.toEqual([])
	})

	test("workspace-files reports a manifest that publishes TypeScript from the workspace root", async () => {
		await using context = await plantFixtureRepository(compilingTree({ files: unscoped }))

		const diagnostics = await workspaceFilesCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual([MANIFEST])
		expect(diagnostics[0]!.details).toContain("*.ts")
	})

	test("workspace-files accepts the list its fix writes", async () => {
		await using context = await plantFixtureRepository(compilingTree({ files: scopedFiles(unscoped) }))

		await expect(workspaceFilesCheck.run(context)).resolves.toEqual([])
	})
})
