/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import ts from "typescript"
import { describe, expect, it } from "vitest"

import { extractEffectEdges } from "#repo-health/effects/extract"
import { type ImportedPaths, summarizeRootedExports } from "#repo-health/effects/resolve"

const FILE = "packages/postcode/lib/shapes.ts"

function edges(text: string, file = FILE, importedPaths: ImportedPaths | null = null) {
	return extractEffectEdges(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file, importedPaths)
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

	it("treats a temporary directory's `path` property, and a scratch path's string form, as scratch", () => {
		const found = edges(`
			import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
			import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
			import { resolvePath } from "path-ts"

			let root

			beforeAll(async () => {
				root = await temporaryDirectory("t-")
			})

			it("reads", async () => {
				await using scratch = await temporaryDirectory("u-")
				const manifest = resolvePath(scratch.path, "manifest.json")
				const out = root.path("districts.db").toString()

				await readLocalJSONFile(manifest)
				await readLocalTextFile(out)
				await readLocalTextFile(\`\${scratch.path}/rows.txt\`)
			})
		`)

		expect(found.map((edge) => edge.target)).toEqual([
			{ root: "scratch", path: "manifest.json" },
			{ root: "scratch", path: "districts.db" },
			{ root: "scratch", path: "rows.txt" },
		])
	})

	it("resolves a workspace path and a package directory builder", () => {
		const found = edges(`
			import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
			import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
			import { workspacePath, workspacePathBuilder } from "@mailwoman/core/paths"

			const fixture = workspacePath("corpus", "fixtures", "es-catastro", "A.gml")
			const fixtures = workspacePathBuilder("corpus", "fixtures")

			await readLocalBuffer(fixture)
			await readLocalBuffer(fixtures("nl", "B.gml"))
			await readLocalTextFile(resolvePackageDirectory("@mailwoman/dictionaries")("data", "ssl-address"))
		`)

		expect(found.map((edge) => edge.target)).toEqual([
			{ root: "repo", path: "packages/corpus/fixtures/es-catastro/A.gml" },
			{ root: "repo", path: "packages/corpus/fixtures/nl/B.gml" },
			{ root: "package", path: "@mailwoman/dictionaries/data/ssl-address" },
		])
	})

	it("resolves a path with a runtime segment to the directory its literal segments name", () => {
		const found = edges(`
			import { readLocalTextFile } from "@mailwoman/core/fs/readers"
			import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
			import { repoRootPath } from "@mailwoman/core/paths"
			import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
			import { PathBuilder } from "path-ts"

			export async function load(name) {
				await using scratch = await temporaryDirectory("t-")

				await readLocalTextFile(resolvePackagePath("@mailwoman/filer", "test-fixtures", "cores", name))
				await readLocalTextFile(PathBuilder.from(scratch.path)(name))
				await readLocalTextFile(repoRootPath(name))
			}
		`)

		// A bare root with a runtime segment would match every change, so it stays unresolved.
		expect(found.map((edge) => edge.target)).toEqual([
			{ root: "package", path: "@mailwoman/filer/test-fixtures/cores" },
			{ root: "scratch", path: "" },
			null,
		])
	})

	it("reports an unresolved name by the shape of the value it holds", () => {
		const found = edges(`
			import { readLocalTextFile } from "@mailwoman/core/fs/readers"

			export async function load(root) {
				const path = sourcePathFor(root)
				const copy = root

				await readLocalTextFile(path)
				await readLocalTextFile(copy)
			}
		`)

		expect(found.map((edge) => edge.unresolvedShape)).toEqual(["call", "parameter"])
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

	it("resolves a package's paths constants and root functions, and a call that imports them", () => {
		const pathsFile = "packages/ban/lib/paths.ts"

		const pathsSource = `
			import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
			import { PathBuilder } from "path-ts"

			export function banDatabaseRoot(dataRoot) {
				return databaseRootPath(dataRoot)("ban")
			}

			export function bdukReleaseRoot(dataRoot) {
				return PathBuilder.from(dataRoot)("bduk")
			}

			export const banDatabasePath = banDatabaseRoot(dataRootPath())
			export const uprnDatabasePath = databaseRootPath(dataRootPath())("uprn")
		`

		const exported = summarizeRootedExports(
			ts.createSourceFile(pathsFile, pathsSource, ts.ScriptTarget.Latest, true),
			pathsFile
		)

		expect(Object.fromEntries(exported)).toEqual({
			banDatabaseRoot: { kind: "function", suffix: "db/ban" },
			bdukReleaseRoot: { kind: "function", suffix: "bduk" },
			banDatabasePath: { kind: "constant", target: { root: "data-root", path: "db/ban" } },
			uprnDatabasePath: { kind: "constant", target: { root: "data-root", path: "db/uprn" } },
		})

		const found = edges(
			`
				import { readLocalTextFile } from "@mailwoman/core/fs/readers"
				import { dataRootPath } from "@mailwoman/core/data-root"
				import { banDatabasePath, banDatabaseRoot } from "@mailwoman/ban/paths"

				await readLocalTextFile(banDatabasePath("ban-fr.db"))
				await readLocalTextFile(banDatabaseRoot(dataRootPath("mirror"))("ban-fr.db"))
			`,
			FILE,
			(specifier) => (specifier === "@mailwoman/ban/paths" ? exported : null)
		)

		expect(found.map((edge) => edge.target)).toEqual([
			{ root: "data-root", path: "db/ban/ban-fr.db" },
			{ root: "data-root", path: "mirror/db/ban/ban-fr.db" },
		])
	})

	it("records a database open as a write, or a read when its options say so, and skips a memory database", () => {
		const found = edges(`
			import { DatabaseClient } from "@mailwoman/sqlite/client"
			import { openBuiltClient } from "@mailwoman/sqlite/sealed"
			import { swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"

			const built = new DatabaseClient("/data/a.db")
			const reader = new DatabaseClient("/data/b.db", { readOnly: true })
			const memory = new DatabaseClient(":memory:")
			using sealed = await openBuiltClient("/data/c.db")
			using staged = await openBuiltClient("/data/d.db", { write: true })
			await swapDatabaseIntoPlace("/data/e.tmp", "/data/e.db")
		`)

		expect(found.map((edge) => [edge.interface, edge.kind, edge.target?.path])).toEqual([
			["DatabaseClient", "write", "/data/a.db"],
			["DatabaseClient", "read", "/data/b.db"],
			["openBuiltClient", "read", "/data/c.db"],
			["openBuiltClient", "write", "/data/d.db"],
			["swapDatabaseIntoPlace", "write", "/data/e.tmp"],
			["swapDatabaseIntoPlace", "write", "/data/e.db"],
		])
	})

	it("records a fetch on an APIClient, its subclass and a bound instance, with the url its request states", () => {
		const found = edges(`
			import { APIClient } from "@mailwoman/core/api"

			const BASE = "https://example.invalid/api"

			class ItemClient extends APIClient {
				item(id) {
					return this.fetch({ method: "GET", url: \`\${BASE}/items\` })
				}
			}

			export async function run(url) {
				await using client = new APIClient({ displayName: "x" })
				await client.fetch({ url: "https://example.invalid/a.json" })
				await new ItemClient({ displayName: "y" }).fetch({ url })
				await other.fetch({ url: "https://example.invalid/b.json" })
			}
		`)

		expect(found.map((edge) => [edge.kind, edge.target?.path ?? edge.unresolvedShape])).toEqual([
			["network", "https://example.invalid/api/items"],
			["network", "https://example.invalid/a.json"],
			["network", "parameter"],
		])
	})

	it("records each variable an env object, process.env or a binding of it reads, and every variable for a whole use", () => {
		const found = edges(`
			import { $private, $public as corePublic } from "@mailwoman/core/env"

			const agent = $private.SEC_EDGAR_USER_AGENT
			const root = corePublic.MAILWOMAN_DATA_ROOT
			const ci = process.env.CI
			const key = process.env["HOME"]
			const { PATH, "NODE_ENV": mode, ...rest } = process.env
			const env = process.env
			const shell = env["SHELL"]
			const dynamic = env[name]
			spawn("x", { env: process.env })
			spawn("y", { env })
		`)

		expect(found.map((edge) => [edge.interface, edge.kind, edge.target?.path ?? edge.unresolvedShape])).toEqual([
			["$private", "environment", "SEC_EDGAR_USER_AGENT"],
			["$public", "environment", "MAILWOMAN_DATA_ROOT"],
			["process.env", "environment", "CI"],
			["process.env", "environment", "HOME"],
			["process.env", "environment", "PATH"],
			["process.env", "environment", "NODE_ENV"],
			["process.env", "environment", "*"],
			["process.env", "environment", "SHELL"],
			["process.env", "environment", "identifier"],
			["process.env", "environment", "*"],
			["process.env", "environment", "*"],
		])
	})

	it("records a spliterator reader's file and a glob's directory, and an absent cwd as unresolved", () => {
		const found = edges(`
			import { JSONSpliterator } from "spliterator"
			import { Globerator } from "spliterator/node/fs"
			import { repoRootPath } from "@mailwoman/core/paths"

			await JSONSpliterator.fromAsync(repoRootPath("data", "rows.jsonl")).toArray()
			await Globerator.files("ts", { cwd: repoRootPath("lib"), absolute: true }).toArray()
			await Globerator.from("*.md").toArray()
		`)

		expect(found.map((edge) => [edge.interface, edge.kind, edge.target?.path ?? edge.unresolvedShape])).toEqual([
			["JSONSpliterator.fromAsync", "read", "data/rows.jsonl"],
			["Globerator.files", "read", "lib"],
			["Globerator.from", "read", "other"],
		])
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
