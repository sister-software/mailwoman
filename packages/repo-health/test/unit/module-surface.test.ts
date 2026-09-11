/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { moduleSurfaceCheck } from "@mailwoman/repo-health/checks/module-surface"
import { resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function plant(path: string, text: string): Promise<{ repoRoot: string; trackedFiles: string[] }> {
	const root = fixtures.use(await temporaryDirectory("module-surface-"))
	await makeDirectories(root.resolve("packages", "fixture", "lib"))
	await writeLocalTextFile(text, resolvePath(root.path, path))

	return { repoRoot: root.path.toString(), trackedFiles: [path] }
}

describe("module-surface", () => {
	it("reports top-level declaration and divider thresholds, but ignores nested declarations and tests", async () => {
		const interfaces = Array.from({ length: 15 }, (_, i) => `interface Shape${i} { value: string }`).join("\n")
		const constants = Array.from({ length: 30 }, (_, i) => `const value${i} = ${i}`).join("\n")
		const functions = Array.from({ length: 20 }, (_, i) => `function step${i}(): void {}`).join("\n")
		const dividers = Array.from({ length: 6 }, (_, i) => `// ${"-".repeat(3)} section ${i} ${"-".repeat(3)}`).join("\n")

		const context = await plant(
			"packages/fixture/lib/large.ts",
			`${interfaces}\n${constants}\n${functions}\n${dividers}\n${"\n".repeat(470)}function wrapper() { interface Nested {} const local = 1; return local }\n`
		)

		const diagnostics = await moduleSurfaceCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			expect.stringContaining("15 top-level interfaces"),
			expect.stringContaining("30 top-level const declarations"),
			expect.stringContaining("21 top-level functions"),
			expect.stringContaining("top-level lines (threshold 500)"),
			expect.stringContaining("6 top-level section-divider comments"),
		])
	})

	it("does not inspect co-located test files", async () => {
		const context = await plant("packages/fixture/lib/large.test.ts", "const onlyTest = true\n")

		expect(await moduleSurfaceCheck.run(context)).toEqual([])
	})
})
