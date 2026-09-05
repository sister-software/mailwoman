/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The manifest-targets check: source mapping, pattern directories, and a clean current tree.
 */

import { collectRepoContext } from "@mailwoman/repo-health"
import {
	manifestTargetsCheck,
	patternDirectory,
	sourceCandidates,
} from "@mailwoman/repo-health/checks/manifest-targets"
import { describe, expect, test } from "vitest"

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
