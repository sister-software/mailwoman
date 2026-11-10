/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import ts from "typescript"
import { describe, expect, it } from "vitest"

import { readsAnyOf, summarizeRuntimeReads } from "#repo-health/ci/runtime-reads"

const ROOT = "/repo"
const TEST = "packages/postcode/lib/shapes.test.ts"

function summarize(text: string, file = "packages/postcode/lib/shapes.ts") {
	return summarizeRuntimeReads(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file, {
		repoRoot: ROOT,
		packageDirectories: new Map([["@mailwoman/codex", "packages/codex"]]),
		importedPaths: null,
	})
}

describe("summarizeRuntimeReads", () => {
	it("maps package, absolute and data-root reads to repository paths and the data-root flag", () => {
		expect(
			summarize(`
				import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
				import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
				import { dataRootPath } from "@mailwoman/core/data-root"

				await readLocalJSONFile(resolvePackagePath("@mailwoman/codex", "data", "tables.json"))
				await readLocalJSONFile(resolvePackagePath("left-pad", "package.json"))
				await readLocalJSONFile("/repo/config/vale/.vale.ini")
				await readLocalJSONFile("/etc/hosts")
				await readLocalJSONFile(dataRootPath("db", "wof", "admin.db"))
			`)
		).toEqual({
			unbounded: null,
			paths: ["config/vale/.vale.ini", "packages/codex/data/tables.json"],
			exact: [],
			dataRoot: true,
		})
	})

	it("keeps a stat or a real path to its exact path, and counts a path built for an effect call once", () => {
		const reads = summarize(`
			import { tryRealPath } from "@mailwoman/core/fs/readers"
			import { pathExists } from "@mailwoman/core/fs/readers/stat"
			import { repoRootPath } from "@mailwoman/core/paths"

			await tryRealPath(repoRootPath())
			await pathExists(repoRootPath("packages", "codex", "out"))
		`)

		expect(reads).toEqual({ unbounded: null, paths: [], exact: ["", "packages/codex/out"], dataRoot: false })
		expect(readsAnyOf(reads!, ["packages/codex/out/index.js"], [])).toBe(false)
		expect(readsAnyOf(reads!, ["packages/codex/out"], [])).toBe(true)
	})

	it("states why a module may read any file", () => {
		expect(summarize("export const load = (name) => import(name)")?.unbounded).toBe(
			"loads a module by a computed specifier"
		)

		expect(summarize('import { runFile } from "@mailwoman/core/process"\nawait runFile("node", [])')?.unbounded).toBe(
			"runs node"
		)
	})

	it("leaves a test unbounded for a raw builtin or an unresolved read, and library code bounded by its callers", () => {
		const raw = 'import { readFileSync } from "node:fs"'

		const read =
			'import { readLocalTextFile } from "@mailwoman/core/fs/readers"\nexport const load = (path) => readLocalTextFile(path)'

		const git = 'import { runFile } from "@mailwoman/core/process"\nawait runFile("git", ["status"])'

		expect(summarize(raw, TEST)?.unbounded).toBe("imports node:fs")
		expect(summarize(read, TEST)?.unbounded).toBe("reads path")

		const callerScript =
			'import { spawnProcess } from "@mailwoman/core/process"\nexport const run = (script) => spawnProcess(process.execPath, [script])'

		expect(summarize(raw)).toBeNull()
		expect(summarize(read)).toBeNull()
		expect(summarize(git)).toBeNull()
		expect(summarize(callerScript)).toBeNull()
		expect(summarize(callerScript, TEST)?.unbounded).toBe("runs process.execPath")
	})

	it("bounds a computed import by the paths an effect-loads comment above its statement declares", () => {
		const declared = [
			"export async function load(name) {",
			"\t// effect-loads: packages/mailwoman/cli/commands, packages/astrogeology/lib/commands",
			"\treturn import(`./commands/${name}.js`)",
			"}",
		].join("\n")

		expect(summarize(declared)).toEqual({
			unbounded: null,
			paths: ["packages/astrogeology/lib/commands", "packages/mailwoman/cli/commands"],
			exact: [],
			dataRoot: false,
		})

		expect(summarize(declared.replace("effect-loads", "loads"))?.unbounded).toBe(
			"loads a module by a computed specifier"
		)
	})

	it("answers null for a module that reads only what it imports", () => {
		expect(summarize('import { value } from "./value.ts"\nexport const doubled = value * 2')).toBeNull()
	})

	it("counts the paths a module builds as reads, including a parameter's default", () => {
		const text = [
			'import { repoRootPath } from "@mailwoman/core/paths"',
			"export function collect(root = repoRootPath()) {}",
			'check(repoRootPath("lib"))',
		].join("\n")

		expect(summarize(text, TEST)?.paths).toEqual(["", "lib"])
		expect(summarize(text)?.paths).toEqual(["", "lib"])
	})
})

describe("readsAnyOf", () => {
	const reads = (paths: string[], unbounded: string | null = null) => ({ unbounded, paths, exact: [], dataRoot: false })

	it("matches a changed file at a read path or under a read directory, and every file for the repository root", () => {
		expect(readsAnyOf(reads(["packages/a/fixtures"]), ["packages/a/fixtures/row.json"], [])).toBe(true)
		expect(readsAnyOf(reads(["packages/a/fixtures"]), ["packages/a/fixtures-old/row.json"], [])).toBe(false)
		expect(readsAnyOf(reads(["packages/a/table.json"]), ["packages/a/table.json"], [])).toBe(true)
		expect(readsAnyOf(reads([""]), ["anything.ts"], [])).toBe(true)
		expect(readsAnyOf(reads([], "reads path"), ["anything.ts"], [])).toBe(true)
	})

	it("matches a source module it reads whenever that module's workspace is affected", () => {
		const runsMain = reads(["packages/mcp/cli/main.ts"])

		expect(readsAnyOf(runsMain, ["packages/gazetteer/lib/sync.ts"], ["packages/gazetteer", "packages/mcp"])).toBe(true)
		expect(readsAnyOf(runsMain, ["packages/gazetteer/lib/sync.ts"], ["packages/gazetteer"])).toBe(false)
	})
})
