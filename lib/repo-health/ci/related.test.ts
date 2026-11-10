import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { createCIRelatedReader, readRelatedCITests, selectRelatedCIScope } from "#repo-health/ci/related"
import type { RuntimeReads } from "#repo-health/ci/runtime-reads"
import { type CIWorkspace, selectCIScope } from "#repo-health/ci/scope"

const reads = (paths: string[], unbounded: string | null = null, dataRoot = false): RuntimeReads => ({
	unbounded,
	paths,
	exact: [],
	dataRoot,
})

const workspaces: CIWorkspace[] = [
	{ name: "a", directory: "packages/a", dependencies: [] },
	{
		name: "b",
		directory: "packages/b",
		dependencies: ["a"],
		runtimeReads: {
			"packages/b/lib/fixture.test.ts": reads(["packages/b/lib/fixtures"]),
			"packages/b/lib/scan.test.ts": reads([""]),
			"packages/b/lib/data.test.ts": reads([], null, true),
			"packages/b/lib/table.ts": reads(["packages/a/data/table.json"]),
		},
	},
	{ name: "c", directory: "packages/c", dependencies: ["a"] },
]

const files = [
	"packages/a/lib/value.test.ts",
	"packages/b/lib/fixture.test.ts",
	"packages/b/lib/scan.test.ts",
	"packages/b/lib/data.test.ts",
	"packages/b/lib/table.test.ts",
	"packages/c/lib/other.test.ts",
]

/**
 * The related-test reader the tests stand in for Vitest: each changed module
 * selects the tests listed for it.
 */
function graph(importers: Record<string, string[]>) {
	return async (changed: readonly string[], config: string): Promise<string[]> =>
		config === "vitest.fast.config.ts" ? [...new Set(changed.flatMap((file) => importers[file] ?? []))] : []
}

async function select(changed: string[], importers: Record<string, string[]>) {
	return selectRelatedCIScope(selectCIScope(workspaces, files, changed, []), workspaces, changed, graph(importers))
}

describe("selectRelatedCIScope", () => {
	it("keeps a test that may read a changed module and drops runtime readers that read elsewhere", async () => {
		const scope = await select(["packages/a/lib/value.ts"], {
			"packages/a/lib/value.ts": ["packages/a/lib/value.test.ts"],
		})

		// The scan test builds the repository root, so it may read the changed module.
		// The fixture test reads only its fixtures, and the data-root test reads only under the data root.
		expect(scope.fastFiles).toEqual(["packages/a/lib/value.test.ts", "packages/b/lib/scan.test.ts"])
	})

	it("narrows a changed data file to the importers of the modules that read it", async () => {
		const scope = await select(["packages/a/data/table.json"], {
			"packages/b/lib/table.ts": ["packages/b/lib/table.test.ts"],
		})

		expect(scope.fastFiles).toEqual(["packages/b/lib/scan.test.ts", "packages/b/lib/table.test.ts"])
	})

	it("keeps a test whose fixture changed", async () => {
		const scope = await select(["packages/b/lib/fixtures/row.json"], {})

		expect(scope.fastFiles).toEqual(["packages/b/lib/fixture.test.ts", "packages/b/lib/scan.test.ts"])
	})

	it("keeps every reader of a module whose reads do not all resolve", async () => {
		const unbounded: CIWorkspace[] = workspaces.map((workspace) =>
			workspace.name === "b"
				? { ...workspace, runtimeReads: { "packages/b/lib/table.ts": reads([], "reads path") } }
				: workspace
		)

		const changed = ["packages/a/data/other.json"]

		const scope = await selectRelatedCIScope(
			selectCIScope(unbounded, files, changed, []),
			unbounded,
			changed,
			graph({ "packages/b/lib/table.ts": ["packages/b/lib/table.test.ts"] })
		)

		expect(scope.fastFiles).toEqual(["packages/b/lib/table.test.ts"])
	})

	it("keeps the importers of a library module that scans the tree when any module changes", async () => {
		const scanning: CIWorkspace[] = workspaces.map((workspace) =>
			workspace.name === "b" ? { ...workspace, runtimeReads: { "packages/b/lib/table.ts": reads([""]) } } : workspace
		)

		const changed = ["packages/a/lib/value.ts"]

		const scope = await selectRelatedCIScope(
			selectCIScope(scanning, files, changed, []),
			scanning,
			changed,
			graph({
				"packages/a/lib/value.ts": ["packages/a/lib/value.test.ts"],
				"packages/b/lib/table.ts": ["packages/b/lib/table.test.ts"],
			})
		)

		expect(scope.fastFiles).toEqual(["packages/a/lib/value.test.ts", "packages/b/lib/table.test.ts"])
	})

	it("reports the selected tests that read under the data root", async () => {
		const scope = await select(["packages/b/lib/data.test.ts"], {
			"packages/b/lib/data.test.ts": ["packages/b/lib/data.test.ts"],
		})

		expect(scope.dataRootFiles).toEqual(["packages/b/lib/data.test.ts"])
	})
})

it("selects transitive imports and excludes independent tests without executing either", async () => {
	await using directory = await temporaryDirectory("ci-related-")
	const root = directory.path
	await writeLocalTextFile('export default { test: { include: ["**/*.test.ts"] } }', root("vitest.config.mts"))
	await writeLocalTextFile("export const value = 1", root("value.ts"))
	await writeLocalTextFile('export { value } from "./value.ts"', root("middle.ts"))
	await writeLocalTextFile('import "./middle.ts"; throw new Error("tests must not execute")', root("related.test.ts"))
	await writeLocalTextFile('throw new Error("tests must not execute")', root("other.test.ts"))
	expect(await readRelatedCITests(root.toString(), ["value.ts"], "vitest.config.mts")).toEqual(["related.test.ts"])
	await using reader = await createCIRelatedReader(root.toString(), "vitest.config.mts")
	expect(await reader.read(["value.ts"])).toEqual(["related.test.ts"])
	expect(await reader.read(["other.test.ts"])).toEqual(["other.test.ts"])
})
