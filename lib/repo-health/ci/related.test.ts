import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { expect, it } from "vitest"

import { createCIRelatedReader, readRelatedCITests, selectRelatedCIScope } from "#repo-health/ci/related"
import { selectCIScope } from "#repo-health/ci/scope"

it("retains the workspace tests of runtime readers while narrowing other consumers", async () => {
	const workspaces = [
		{ name: "a", directory: "packages/a", dependencies: [] },
		{ name: "b", directory: "packages/b", dependencies: ["a"], runtimeTests: ["packages/b/lib/read.test.ts"] },
		{ name: "c", directory: "packages/c", dependencies: ["a"] },
	]

	const files = ["packages/a/lib/value.test.ts", "packages/b/lib/read.test.ts", "packages/c/lib/other.test.ts"]
	const changed = ["packages/a/lib/value.ts"]

	const scope = await selectRelatedCIScope(
		selectCIScope(workspaces, files, changed, []),
		workspaces,
		changed,
		async (_inputs, config) => (config === "vitest.fast.config.ts" ? [files[0]!] : [])
	)

	expect(scope.fastFiles).toEqual(files.slice(0, 2))
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
