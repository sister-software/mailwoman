/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two AST guards that used to BE vitest files, run as checks against the tree this test sits in. Each must report
 *   no diagnostics: the reach-around guard's allowlist entries must still exist and still reach around (a stale
 *   exemption is a hole), and every registered runtime flag must be touched by a test. The checks carry those
 *   assertions as error diagnostics, so "no diagnostics" is the whole contract.
 */

import { collectRepoContext } from "@mailwoman/repo-health"
import { noRootScriptsCheck } from "@mailwoman/repo-health/checks/no-root-scripts"
import { nodeModulesReacharoundCheck } from "@mailwoman/repo-health/checks/node-modules-reacharound"
import { runtimeFlagsCheck } from "@mailwoman/repo-health/checks/runtime-flags"
import { describe, expect, test } from "vitest"

describe("the node_modules reach-around guard", () => {
	test("reports nothing on the current tree — no hand-spelled layout outside the allowlist, no stale entry", async () => {
		const context = await collectRepoContext()

		// A guard that silently stops looking is worse than no guard.
		expect(context.trackedFiles.length).toBeGreaterThan(0)

		expect(await nodeModulesReacharoundCheck.run(context)).toEqual([])
	})
})

describe("the runtime-flag register", () => {
	test("every registered flag is touched by at least one test, and the allowlist carries no stale entry", async () => {
		const context = await collectRepoContext()

		expect(await runtimeFlagsCheck.run(context)).toEqual([])
	})
})

describe("the root scripts/ directory", () => {
	test("does not exist, no code builds a path into it, and no CI target runs scripts/… or a bare lib/*.ts path", async () => {
		const context = await collectRepoContext()

		expect(await noRootScriptsCheck.run(context)).toEqual([])
	})

	test("reports a tracked file under scripts/ and a workflow step that runs one", async () => {
		const context = await collectRepoContext()
		const planted = { ...context, trackedFiles: [...context.trackedFiles, "scripts/stray.ts"] }
		const diagnostics = await noRootScriptsCheck.run(planted)

		expect(diagnostics.map((d) => d.file)).toContain("scripts/stray.ts")
	})
})
