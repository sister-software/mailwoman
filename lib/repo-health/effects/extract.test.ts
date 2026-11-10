/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import ts from "typescript"
import { describe, expect, it } from "vitest"

import { extractEffectEdges } from "#repo-health/effects/extract"

const FILE = "packages/postcode/lib/shapes.ts"

function edges(text: string, file = FILE) {
	return extractEffectEdges(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file)
}

describe("extractEffectEdges", () => {
	it("resolves a literal, a root builder and a module-relative path, each to its root", () => {
		const found = edges(`
			import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
			import { dataRootPath } from "@mailwoman/core/data-root"
			import { repoRootPath } from "@mailwoman/core/paths"
			import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
			import { resolvePath } from "path-ts"

			await readLocalTextFile("/etc/hosts")
			await readLocalJSONFile(repoRootPath("packages", "postcode", "data", "shapes.json"))
			await readLocalTextFile(dataRootPath("db", "wof", "admin.db"))
			await readLocalJSONFile(resolvePackagePath("@mailwoman/codex", "data", "tables.json"))
			await readLocalTextFile(resolvePath(import.meta.dirname, "fixtures", "row.txt"))
			await readLocalBuffer(new URL("../wasm/x.wasm", import.meta.url))
		`)

		expect(found.map((edge) => [edge.interface, edge.kind, edge.target])).toEqual([
			["readLocalTextFile", "read", { root: "literal", path: "/etc/hosts" }],
			["readLocalJSONFile", "read", { root: "repo", path: "packages/postcode/data/shapes.json" }],
			["readLocalTextFile", "read", { root: "data-root", path: "db/wof/admin.db" }],
			["readLocalJSONFile", "read", { root: "package", path: "@mailwoman/codex/data/tables.json" }],
			["readLocalTextFile", "read", { root: "repo", path: "packages/postcode/lib/fixtures/row.txt" }],
		])
	})

	it("reads the path argument a writer takes after its content, and both paths of a copy", () => {
		const found = edges(`
			import { copyFileTo, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
			import { dataRootPath } from "@mailwoman/core/data-root"

			await writeLocalJSONFile({ a: 1 }, dataRootPath("out", "a.json"))
			await copyFileTo("/tmp/in.db", dataRootPath("db", "out.db"))
		`)

		expect(found.map((edge) => [edge.interface, edge.kind, edge.target])).toEqual([
			["writeLocalJSONFile", "write", { root: "data-root", path: "out/a.json" }],
			["copyFileTo", "read", { root: "literal", path: "/tmp/in.db" }],
			["copyFileTo", "write", { root: "data-root", path: "db/out.db" }],
		])
	})

	it("follows a module-level constant and an aliased import", () => {
		const found = edges(`
			import { readLocalTextFile as read } from "@mailwoman/core/fs/readers"
			import { dataRootPath } from "@mailwoman/core/data-root"

			const ADMIN = dataRootPath("db", "admin.db")

			export async function load() {
				return read(ADMIN)
			}
		`)

		expect(found).toEqual([
			{
				file: FILE,
				line: 8,
				interface: "readLocalTextFile",
				kind: "read",
				target: { root: "data-root", path: "db/admin.db" },
				unresolved: null,
				unresolvedShape: null,
			},
		])
	})

	it("follows a function-local constant, a PathBuilder value and a temporary directory's paths", () => {
		const found = edges(`
			import { readLocalTextFile } from "@mailwoman/core/fs/readers"
			import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
			import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
			import { dataRootPath } from "@mailwoman/core/data-root"
			import { PathBuilder } from "path-ts"

			export async function run() {
				const fixture = dataRootPath("eval", "rows.jsonl")
				const root = PathBuilder.from(dataRootPath("db"))
				await using scratch = await temporaryDirectory("effects-")

				await readLocalTextFile(fixture)
				await readLocalTextFile(root("admin.db"))
				await writeLocalTextFile("x", scratch.path("out.txt"))
			}
		`)

		expect(found.map((edge) => [edge.interface, edge.target])).toEqual([
			["readLocalTextFile", { root: "data-root", path: "eval/rows.jsonl" }],
			["readLocalTextFile", { root: "data-root", path: "db/admin.db" }],
			["writeLocalTextFile", { root: "scratch", path: "out.txt" }],
		])
	})

	it("treats a temporary directory reached through a stack, a let binding or a builder as scratch", () => {
		const found = edges(`
			import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
			import { temporaryDirectory } from "@mailwoman/core/fs/temporary"

			const fixtures = new AsyncDisposableStack()
			let dir

			beforeEach(async () => {
				dir = fixtures.use(await temporaryDirectory("t-")).path
			})

			it("writes", async () => {
				const root = fixtures.use(await temporaryDirectory("u-")).path
				const workspace = root("packages", name)
				await writeLocalTextFile("x", dir("a.bin"))
				await writeLocalTextFile("x", workspace("out", "b.json"))
			})
		`)

		// A scratch path keeps the segments of the call that names it, since its base is the run's own directory.
		expect(found.map((edge) => edge.target)).toEqual([
			{ root: "scratch", path: "a.bin" },
			{ root: "scratch", path: "out/b.json" },
		])
	})

	it("resolves a name declared in two functions to the declaration in scope at each use", () => {
		const found = edges(`
			import { readLocalTextFile } from "@mailwoman/core/fs/readers"

			function a() {
				const path = "/a"
				return readLocalTextFile(path)
			}

			function b() {
				const path = "/b"
				return readLocalTextFile(path)
			}
		`)

		expect(found.map((edge) => edge.target)).toEqual([
			{ root: "literal", path: "/a" },
			{ root: "literal", path: "/b" },
		])
	})

	it("records a path built from runtime values as unresolved, with its expression, rather than dropping it", () => {
		const found = edges(`
			import { readLocalTextFile } from "@mailwoman/core/fs/readers"

			export function load(path: string) {
				return readLocalTextFile(path)
			}
		`)

		expect(found).toEqual([
			{
				file: FILE,
				line: 5,
				interface: "readLocalTextFile",
				kind: "read",
				target: null,
				unresolved: "path",
				unresolvedShape: "parameter",
			},
		])
	})

	it("ignores a same-named function from another module and a local function", () => {
		const found = edges(`
			import { readLocalTextFile } from "./local-shim"

			function pathExists() {}

			readLocalTextFile("/x")
			pathExists("/y")
		`)

		expect(found).toEqual([])
	})

	it("records a child process and a fetch as their own edge kinds", () => {
		const found = edges(`
			import { runFile } from "@mailwoman/core/process"

			await runFile("git", ["status"])
			await fetch("https://example.invalid/data.json")
		`)

		expect(found.map((edge) => [edge.interface, edge.kind, edge.target])).toEqual([
			["runFile", "process", { root: "literal", path: "git" }],
			["fetch", "network", { root: "literal", path: "https://example.invalid/data.json" }],
		])
	})
})
