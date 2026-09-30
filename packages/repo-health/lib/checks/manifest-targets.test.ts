/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The manifest-targets check: source mapping, pattern directories and a clean current tree.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, test } from "vitest"

import {
	compilerAdmits,
	manifestTargetsCheck,
	patternDirectory,
	sourceCandidates,
	tsconfigGlob,
} from "#checks/manifest-targets"
import { collectRepoContext } from "#index"

/**
 * The corpus workspace's scope as it was when its `./test-kit` export referred
 * to a source the config excluded.
 */
const CORPUS_SCOPE = {
	include: ["./lib/**/*"],
	exclude: ["./out/**/*", "./test/**/*", "./**/*.test.ts", "./**/*.test.tsx", "./fixtures/**/*", "./lib/test-kit/**/*"],
}

describe("manifest-targets", () => {
	test("maps a compiled target back to the source that emits it", () => {
		expect(sourceCandidates("packages/core", "./out/utils/hash.js")).toEqual([
			"packages/core/lib/utils/hash.ts",
			"packages/core/lib/utils/hash.tsx",
			"packages/core/lib/utils/hash/index.ts",
		])

		expect(sourceCandidates("packages/core", "./out/stats.d.ts")[0]).toBe("packages/core/lib/stats.ts")
		expect(sourceCandidates("docs", "./out/plugins/x.js")[0]).toBe("docs/src/plugins/x.ts")
		expect(sourceCandidates("packages/core", "./data/wof.json")).toEqual(["packages/core/data/wof.json"])
	})

	test("resolves a pattern's directory through the same mapping", () => {
		expect(patternDirectory("packages/core", "./out/filters/*.js")).toBe("packages/core/lib/filters/")
		expect(patternDirectory("packages/core", "./lib/*.ts")).toBe("packages/core/lib/")
	})

	test("maps a target under an extra source root to that root rather than lib/", () => {
		expect(patternDirectory("packages/zoning", "./out/sdk/*.js", ["sdk"])).toBe("packages/zoning/sdk/")
		expect(sourceCandidates("packages/zoning", "./out/sdk/cells.d.ts", ["sdk"])[0]).toBe("packages/zoning/sdk/cells.ts")
		expect(sourceCandidates("packages/zoning", "./out/cells.js", ["sdk"])[0]).toBe("packages/zoning/lib/cells.ts")
	})

	test("reads a tsconfig glob the way tsc does", () => {
		expect(tsconfigGlob("./lib/**/*").test("lib/test-kit/index.ts")).toBe(true)
		expect(tsconfigGlob("./lib/**/*").test("lib/build.ts")).toBe(true)
		expect(tsconfigGlob("./lib/**/*").test("test/fixtures/x.ts")).toBe(false)
		expect(tsconfigGlob("./**/*.test.ts").test("lib/deep/x.test.ts")).toBe(true)
		expect(tsconfigGlob("./**/*.test.ts").test("x.test.ts")).toBe(true)
		expect(tsconfigGlob("./**/*.test.ts").test("lib/x.ts")).toBe(false)
		expect(tsconfigGlob("./test/**").test("test/fixtures/x.ts")).toBe(true)
		expect(tsconfigGlob("out").test("out/x.js")).toBe(true)
		expect(tsconfigGlob("out").test("outside/x.ts")).toBe(false)
		expect(tsconfigGlob(".docusaurus").test(".docusaurus/x.ts")).toBe(true)
		expect(tsconfigGlob("./vitest.config.ts").test("vitest.config.ts")).toBe(true)
		expect(tsconfigGlob("./vitest.config.ts").test("lib/vitest.config.ts")).toBe(false)
	})

	test("admits a source inside include and outside every exclude", () => {
		expect(compilerAdmits(CORPUS_SCOPE, "lib/build.ts")).toBe(true)
		expect(compilerAdmits(CORPUS_SCOPE, "lib/test-kit/index.ts")).toBe(false)
		expect(compilerAdmits(CORPUS_SCOPE, "lib/recipes/x.test.ts")).toBe(false)
		expect(compilerAdmits(CORPUS_SCOPE, "test/fixtures/x.ts")).toBe(false)
		expect(compilerAdmits({}, "anything/at/all.ts")).toBe(true)
	})

	test("reports a compiled target whose tracked source the workspace tsconfig does not compile", async () => {
		await using scratch = await temporaryDirectory("manifest-targets-")

		await writeLocalJSONFile({ workspaces: ["pkg"] }, scratch.path("package.json"))

		await writeLocalJSONFile(
			{
				name: "pkg",
				exports: {
					"./kept": { default: "./out/kept.js" },
					"./excluded": { default: "./out/excluded/index.js" },
					"./recipes/*": { default: "./out/recipes/*.js" },
					"./raw/*": { default: "./lib/excluded/*.ts" },
				},
			},
			scratch.path("pkg", "package.json")
		)

		await writeLocalTextFile(
			`{\n\t// a line comment, as the workspace configs carry\n\t"include": ["./lib/**/*"],\n\t"exclude": ["./lib/excluded/**/*", "./lib/recipes/**/*"]\n}\n`,
			scratch.path("pkg", "tsconfig.json")
		)

		const diagnostics = await manifestTargetsCheck.run({
			repoRoot: scratch.path.toString(),
			trackedFiles: ["pkg/lib/kept.ts", "pkg/lib/excluded/index.ts", "pkg/lib/recipes/a.ts"],
		})

		const subpaths = diagnostics.map((d) => /\["([^"]+)"\]/u.exec(d.message)?.[1])

		expect(subpaths.toSorted()).toEqual(["./excluded", "./recipes/*"])

		expect(diagnostics.find((d) => d.message.includes('"./excluded"'))?.message).toContain(
			"pkg/lib/excluded/index.ts is tracked, but pkg/tsconfig.json does not compile it"
		)

		expect(diagnostics.find((d) => d.message.includes('"./recipes/*"'))?.message).toContain(
			"compiles none of the 1 tracked files under pkg/lib/recipes/"
		)
	})

	test("reports nothing on the current tree", async () => {
		const context = await collectRepoContext()

		expect(context.trackedFiles.length).toBeGreaterThan(0)
		expect(await manifestTargetsCheck.run(context)).toEqual([])
	})

	test("reports a target whose source is gone", async () => {
		const context = await collectRepoContext()

		const withoutStats = {
			...context,
			trackedFiles: context.trackedFiles.filter((p) => p !== "packages/core/lib/stats.ts"),
		}

		const diagnostics = await manifestTargetsCheck.run(withoutStats)

		expect(diagnostics.some((d) => d.file === "packages/core/package.json" && d.message.includes('"./stats"'))).toBe(
			true
		)
	})
})
