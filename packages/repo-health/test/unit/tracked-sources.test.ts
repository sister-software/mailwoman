/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pathspec filter has to answer what `git ls-files -- <pathspec>` answered, because the debt baseline was recorded
 *   against the spawned command. The `scripts/**\/*.ts` case is the one that decides a counter's population.
 */

import { pathspecPattern, trackedSourcePaths } from "@mailwoman/repo-health/tracked-sources"
import { describe, expect, it } from "vitest"

describe("pathspecPattern", () => {
	it("lets `*` cross directory separators, as git's fnmatch does", () => {
		expect(pathspecPattern("*.ts").test("packages/core/lib/index.ts")).toBe(true)
		expect(pathspecPattern("*.ts").test("packages/core/lib/index.tsx")).toBe(false)
		expect(pathspecPattern("packages/*.test.ts").test("packages/core/test/unit/a.test.ts")).toBe(true)
	})

	it("reads `**` as two stars, so `scripts/**/*.ts` needs a directory between `scripts/` and the file", () => {
		// Measured against `git ls-files -- 'scripts/**/*.ts'`: 31 files listed, 0 of them at the top of `scripts/`.
		const pattern = pathspecPattern("scripts/**/*.ts")

		expect(pattern.test("scripts/eval/audit-affix-misses.ts")).toBe(true)
		expect(pattern.test("scripts/copy-weights.ts")).toBe(false)
	})

	it("treats a wildcard-free pathspec as a leading path", () => {
		expect(pathspecPattern(".husky").test(".husky/pre-commit")).toBe(true)
		expect(pathspecPattern(".husky").test(".huskyrc")).toBe(false)
		expect(pathspecPattern("package.json").test("package.json")).toBe(true)
	})
})

describe("trackedSourcePaths", () => {
	const context = {
		repoRoot: "/repo",
		trackedFiles: [
			"packages/core/lib/index.ts",
			"packages/core/lib/types.d.ts",
			"packages/core/out/index.js",
			"packages/core/out/index.ts",
			"docs/src/page.tsx",
			"README.md",
			".github/workflows/test.yml",
		],
	}

	it("defaults to every .ts/.tsx, dropping declarations and anything under out/", async () => {
		expect(await trackedSourcePaths(context)).toEqual(["/repo/packages/core/lib/index.ts", "/repo/docs/src/page.tsx"])
	})

	it("honors prefix, excludePrefixes and includeDeclarations", async () => {
		expect(await trackedSourcePaths(context, { prefix: "packages/", includeDeclarations: true })).toEqual([
			"/repo/packages/core/lib/index.ts",
			"/repo/packages/core/lib/types.d.ts",
		])

		expect(await trackedSourcePaths(context, { excludePrefixes: ["packages/"] })).toEqual(["/repo/docs/src/page.tsx"])
	})

	it("takes the wire pathspecs the debt counter passes", async () => {
		expect(await trackedSourcePaths(context, { globs: [".github/workflows/*", ".husky/*"] })).toEqual([
			"/repo/.github/workflows/test.yml",
		])

		// `*` reaches every tracked file; the two under out/ and the declaration are still dropped.
		expect(await trackedSourcePaths(context, { globs: ["*"] })).toHaveLength(4)
	})
})
