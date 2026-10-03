import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { readCIWorkspaces, selectCIScope, type CIWorkspace } from "#ci-scope"

const workspaces: CIWorkspace[] = [
	{ name: "@mailwoman/core", directory: "packages/core", dependencies: [] },
	{ name: "@mailwoman/react", directory: "packages/react", dependencies: ["@mailwoman/core"] },
	{ name: "@mailwoman/earth", directory: "packages/earth", dependencies: ["@mailwoman/react"] },
	{ name: "@mailwoman/planetary", directory: "packages/planetary", dependencies: ["@mailwoman/react"] },
	{ name: "@mailwoman/license-worker", directory: "packages/license-worker", dependencies: [] },
	{ name: "@mailwoman/corpus", directory: "packages/corpus", dependencies: [] },
	{ name: "@mailwoman/docs", directory: "docs", dependencies: ["@mailwoman/react"] },
]
const files = [
	"vitest.test.ts",
	"packages/core/lib/path.test.ts",
	"packages/core/lib/path.integration.test.ts",
	"packages/core/lib/path.full.test.ts",
	"packages/react/lib/button.test.tsx",
	"packages/react/lib/button.integration.test.tsx",
	"packages/earth/test/e2e/map.spec.ts",
	"packages/license-worker/lib/key.test.ts",
	"packages/corpus/lib/adapter.test.ts",
	"packages/corpus/lib/adapter.integration.test.ts",
	"packages/corpus/examples/sample.test.ts",
	"docs/src/page.test.tsx",
	"docs/test/browser/page.test.ts",
]

describe("selectCIScope", () => {
	it("selects transitive consumers and their browser suites", () => {
		const scope = selectCIScope(workspaces, files, ["packages/core/lib/path.ts"], ["packages/core"])

		expect(scope.full).toBe(false)
		expect(scope.affected).toEqual(["docs", "packages/core", "packages/earth", "packages/planetary", "packages/react"])
		expect(scope.fastFiles).toEqual(["docs/src/page.test.tsx", "packages/core/lib/path.test.ts"])
		expect(scope.slowFiles).toEqual(["packages/core/lib/path.integration.test.ts"])
		expect(scope).toMatchObject({
			earth: true,
			react: true,
			planetary: true,
			worker: false,
			docs: true,
			smoke: true,
			python: false,
		})
	})

	it("selects workspace tests for a fixture change without selecting unrelated browser suites", () => {
		const scope = selectCIScope(workspaces, files, ["packages/corpus/fixtures/quoted-newline.csv"], ["packages/corpus"])

		expect(scope.fastFiles).toEqual(["packages/corpus/lib/adapter.test.ts"])
		expect(scope.slowFiles).toEqual(["packages/corpus/lib/adapter.integration.test.ts"])
		expect(scope).toMatchObject({ earth: false, react: false, smoke: true })
	})

	it("visits dependency cycles once", () => {
		const cyclic = [
			{ name: "a", directory: "packages/a", dependencies: ["b"] },
			{ name: "b", directory: "packages/b", dependencies: ["a"] },
		]

		expect(selectCIScope(cyclic, [], ["packages/a/lib/value.ts"], []).affected).toEqual(["packages/a", "packages/b"])
	})

	it.each([
		"yarn.lock",
		"test/shared-fixture.json",
		"data/new-layer.bin",
		"packages/removed/lib/module.ts",
		"packages/core/package.json",
	])("selects every suite for %s", (file) => {
		expect(selectCIScope(workspaces, files, [file], [])).toMatchObject({
			full: true,
			fast: true,
			slow: true,
			earth: true,
			python: true,
			lexicon: true,
		})
	})

	it("selects both workspaces when a diff supplies the old and new paths of a move", () => {
		const scope = selectCIScope(workspaces, files, ["packages/core/lib/old.ts", "packages/corpus/lib/new.ts"], [])

		expect(scope.affected).toContain("packages/core")
		expect(scope.affected).toContain("packages/corpus")
	})

	it("selects Python independently and includes Python fixtures in workspace changes", () => {
		expect(selectCIScope(workspaces, files, ["corpus-python/src/reader.py"], [])).toMatchObject({
			python: true,
			fast: false,
			slow: false,
			earth: false,
		})
		expect(selectCIScope(workspaces, files, ["packages/corpus/fixtures/generate.py"], []).python).toBe(true)
	})

	it("selects JavaScript consumers of a Python script or fixture", () => {
		const consumers = workspaces.map((workspace) =>
			workspace.name === "@mailwoman/corpus"
				? { ...workspace, externalInputs: ["corpus-python/scripts/reader.py"] }
				: workspace
		)

		expect(selectCIScope(consumers, files, ["corpus-python/scripts/reader.py"], []).fastFiles).toEqual([
			"packages/corpus/lib/adapter.test.ts",
		])
		expect(selectCIScope(consumers, files, ["corpus-python/src/unrelated.py"], []).fast).toBe(false)
	})

	it("selects every suite for main and dispatched runs, including empty test populations", () => {
		expect(selectCIScope(workspaces, [], [], [], true)).toMatchObject({
			full: true,
			fast: true,
			slow: true,
			earth: true,
			python: true,
		})
	})
})

describe("readCIWorkspaces", () => {
	it("adds literal test imports, dynamic imports, and relative imports to manifest dependencies", async () => {
		await using directory = await temporaryDirectory("ci-workspaces-")
		const root = directory.path

		await writeLocalJSONFile({ workspaces: ["packages/*"] }, root("package.json"))
		await writeLocalJSONFile({ name: "a", devDependencies: { b: "workspace:*" } }, root("packages/a/package.json"))
		await writeLocalJSONFile({ name: "b" }, root("packages/b/package.json"))
		await writeLocalJSONFile({ name: "c" }, root("packages/c/package.json"))
		await writeLocalTextFile(
			'import "c/value";\nawait import("c/other");\nrepoRootPath("corpus-python", "scripts", "reader.py");\n',
			root("packages/a/lib/value.test.ts")
		)
		await writeLocalTextFile('export { value } from "../../c/lib/value.ts";\n', root("packages/b/lib/value.ts"))

		const graph = await readCIWorkspaces(root.toString(), ["packages/a/lib/value.test.ts", "packages/b/lib/value.ts"])

		expect(graph.find((workspace) => workspace.name === "a")?.dependencies).toEqual(["b", "c"])
		expect(graph.find((workspace) => workspace.name === "a")?.externalInputs).toEqual([
			"corpus-python/scripts/reader.py",
		])
		expect(graph.find((workspace) => workspace.name === "b")?.dependencies).toEqual(["c"])
	})

	it("raises an error when a requested source file cannot be read", async () => {
		await using directory = await temporaryDirectory("ci-unreadable-")
		const root = directory.path

		await writeLocalJSONFile({ workspaces: ["packages/*"] }, root("package.json"))
		await writeLocalJSONFile({ name: "a" }, root("packages/a/package.json"))

		await expect(readCIWorkspaces(root.toString(), ["packages/a/lib/missing.ts"])).rejects.toThrow(/ENOENT/u)
	})
})
