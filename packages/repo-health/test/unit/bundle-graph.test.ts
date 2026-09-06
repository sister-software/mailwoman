/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The bundle-graph check against the tree this test sits in, plus a row that must fail: a check that reports nothing
 *   is only evidence once it has been seen to report something, and `@mailwoman/core/fs/readers` imports
 *   `node:fs/promises` statically by design.
 */

import { collectRepoContext } from "@mailwoman/repo-health"
import { bundleGraphCheck, evaluateBundleRow } from "@mailwoman/repo-health/checks/bundle-graph"
import { describe, expect, test } from "vitest"

describe("the bundle-graph check", () => {
	test("reports nothing on the current tree", async () => {
		const context = await collectRepoContext()

		expect(await bundleGraphCheck.run(context)).toEqual([])
	})

	test("reports a static builtin edge, named by the file that makes it", async () => {
		const context = await collectRepoContext()

		const diagnostics = await evaluateBundleRow(
			{ entry: "@mailwoman/core/fs/readers", platform: "browser", conditions: ["browser"] },
			context.repoRoot
		)

		expect(diagnostics.map((entry) => entry.message)).toContainEqual(
			expect.stringMatching(/core\/out\/fs\/readers\.js → node:fs\/promises on a static chain$/u)
		)
	})

	test("reports a dynamic builtin import no row lists", async () => {
		const context = await collectRepoContext()

		const diagnostics = await evaluateBundleRow(
			{ entry: "@mailwoman/neural/web-loader", platform: "browser", conditions: ["browser"] },
			context.repoRoot
		)

		expect(diagnostics.map((entry) => entry.message)).toContainEqual(
			expect.stringMatching(/tokenizer\.js dynamically imports node:fs\/promises, which no row lists$/u)
		)
	})
})
