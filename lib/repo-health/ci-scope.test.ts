import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { readCIWorkspaces, selectCIScope, type CIWorkspace } from "#repo-health/ci-scope"

const workspaces: CIWorkspace[] = [
	{ name: "@mailwoman/core", directory: "packages/core", dependencies: [] },
	{ name: "@mailwoman/react", directory: "packages/react", dependencies: ["@mailwoman/core"] },
	{ name: "@mailwoman/earth", directory: "packages/earth", dependencies: ["@mailwoman/react"] },
	{ name: "@mailwoman/planetary", directory: "packages/planetary", dependencies: ["@mailwoman/react"] },
	{ name: "@mailwoman/opportunity-map", directory: "packages/opportunity-map", dependencies: [] },
	{
		name: "@mailwoman/opportunity-app",
		directory: "packages/opportunity-app",
		dependencies: ["@mailwoman/react", "@mailwoman/opportunity-map"],
	},
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
	"packages/opportunity-map/lib/selection.test.ts",
	"packages/opportunity-app/lib/controls.test.ts",
	"packages/opportunity-app/test/browser/keyboard.spec.ts",
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

		expect(scope.affected).toEqual([
			"docs",
			"packages/core",
			"packages/earth",
			"packages/opportunity-app",
			"packages/planetary",
			"packages/react",
		])

		expect(scope.fastFiles).toEqual([
			"docs/src/page.test.tsx",
			"packages/core/lib/path.test.ts",
			"packages/opportunity-app/lib/controls.test.ts",
		])

		expect(scope.slowFiles).toEqual(["packages/core/lib/path.integration.test.ts"])

		expect(scope).toMatchObject({
			earth: true,
			react: true,
			planetary: true,
			opportunity: true,
			worker: false,
			docs: true,
			smoke: true,
			rust: false,
		})
	})

	it("selects the opportunity application's browser tests for a change in it or in the map model it draws", () => {
		for (const file of ["packages/opportunity-app/lib/App.tsx", "packages/opportunity-map/lib/selection.ts"]) {
			const scope = selectCIScope(workspaces, files, [file], [])

			expect(scope.full).toBe(false)
			expect(scope).toMatchObject({ opportunity: true, react: false, planetary: false, earth: false })
			expect(scope.fastFiles).toContain("packages/opportunity-app/lib/controls.test.ts")
			expect(scope.fastFiles).not.toContain("packages/opportunity-app/test/browser/keyboard.spec.ts")
		}
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
			rust: true,
			lexicon: true,
		})
	})

	it("selects both workspaces when a diff supplies the old and new paths of a move", () => {
		const scope = selectCIScope(workspaces, files, ["packages/core/lib/old.ts", "packages/corpus/lib/new.ts"], [])

		expect(scope.affected).toContain("packages/core")
		expect(scope.affected).toContain("packages/corpus")
	})

	const withMTF = [...workspaces, { name: "@mailwoman/mtf", directory: "packages/mtf", dependencies: [] }]

	it.each(["packages/mtf/crates/mtf-channels/src/anchor.rs", "packages/mtf/crates/mtf-core/Cargo.toml"])(
		"selects the rust job for %s, an mtf crate input",
		(file) => {
			expect(selectCIScope(withMTF, files, [file], [])).toMatchObject({ full: false, rust: true })
		}
	)

	it.each(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"])(
		"selects the rust job and every suite for %s, a root cargo workspace file",
		(file) => {
			expect(selectCIScope(withMTF, files, [file], [])).toMatchObject({ full: true, rust: true })
		}
	)

	it.each(["packages/trainer/crates/trainer-export/src/quantize.rs", "packages/trainer/crates/trainer-cli/Cargo.toml"])(
		"selects only the job that tests the trainer crates for %s",
		(file) => {
			expect(selectCIScope(workspaces, files, [file], [])).toMatchObject({
				full: false,
				rust: true,
				fast: false,
				slow: false,
			})
		}
	)

	it("selects every suite for a trainer data table, which the JavaScript tests read too", () => {
		expect(selectCIScope(workspaces, files, ["packages/trainer/data/postcode-shapes.json"], [])).toMatchObject({
			full: true,
			rust: true,
		})
	})

	it("leaves the rust job unselected for an mtf change outside the crates", () => {
		expect(selectCIScope(withMTF, files, ["packages/mtf/lib/index.ts"], [])).toMatchObject({
			full: false,
			rust: false,
		})
	})

	it("selects every suite for main and dispatched runs, including empty test populations", () => {
		expect(selectCIScope(workspaces, [], [], [], true)).toMatchObject({
			full: true,
			fast: true,
			slow: true,
			earth: true,
			rust: true,
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

		await writeLocalTextFile('import "c/value";\nawait import("c/other");\n', root("packages/a/lib/value.test.ts"))

		await writeLocalTextFile('export { value } from "../../c/lib/value.ts";\n', root("packages/b/lib/value.ts"))

		const graph = await readCIWorkspaces(root.toString(), ["packages/a/lib/value.test.ts", "packages/b/lib/value.ts"])

		expect(graph.find((workspace) => workspace.name === "a")?.dependencies).toEqual(["b", "c"])

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
