/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The checks that assert about the tree this test sits in, run as tests. Each must report no diagnostics: the
 *   reach-around guard's allowlist entries must still exist and still reach around (a stale exemption is a hole), every
 *   registered runtime flag must be touched by a test, and the scope register must still agree with the declaration it
 *   encodes. The checks carry those assertions as error diagnostics, so "no diagnostics" is the whole contract.
 *
 *   This file is also the ONLY place several of them run. `yarn lint`'s health leg invokes four checks by id — `debt`,
 *   `bundle-graph`, `exports`, `test-contract` — and no workflow runs `mwops health all`, so a registered check with no
 *   test here is a check nothing executes. Registering one without a case below leaves it in the state it exists to
 *   prevent.
 *
 *   A check belongs here only if it reads a FIXED set of files. `locale-tables` does not: it walks every tracked source
 *   for a country→locale map, so it throws on a checkout whose index is ahead of its disk — a rename in progress in
 *   another worktree is enough. Its planted-tree cases cover the logic; a current-tree case would report the developer's
 *   working state instead.
 */

import { collectRepoContext } from "@mailwoman/repo-health"
import { localeScopeCheck } from "@mailwoman/repo-health/checks/locale/scope"
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

describe("the locale scope register", () => {
	test("scope.config.json names the same countries per tier as SCOPE.mdx, and places every shipping locale", async () => {
		const context = await collectRepoContext()

		expect(await localeScopeCheck.run(context)).toEqual([])
	})
})
