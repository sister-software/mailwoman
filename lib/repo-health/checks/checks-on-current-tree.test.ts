import { describe, expect, test } from "vitest"

import { localeScopeCheck } from "#repo-health/checks/locale/scope"
import { localeTablesCheck } from "#repo-health/checks/locale/tables"
import { noRootScriptsCheck } from "#repo-health/checks/no-root-scripts"
import { nodeModulesReacharoundCheck } from "#repo-health/checks/node-modules-reacharound"
import { runtimeFlagsCheck } from "#repo-health/checks/runtime-flags"
import { stylesheetCheck } from "#repo-health/checks/stylesheet-check"
import { collectRepoContext } from "#repo-health/index"

describe("The node_modules reach-around condition", () => {
	test("Reports nothing on the current tree — neither hand-spelled layout outside the allowlist nor stale entry", async () => {
		const context = await collectRepoContext()

		expect(context.trackedFiles.length).toBeGreaterThan(0)

		await expect(nodeModulesReacharoundCheck.run(context)).resolves.toEqual([])
	})
})

describe("the runtime-flag register", () => {
	test("every registered flag is touched by at least one test, and the allowlist carries no stale entry", async () => {
		const context = await collectRepoContext()

		await expect(runtimeFlagsCheck.run(context)).resolves.toEqual([])
	})
})

describe("the root scripts/ directory", () => {
	test("Does not exist without code builds a path into it, and no CI target runs scripts/… or a bare lib/*.ts path", async () => {
		const context = await collectRepoContext()

		await expect(noRootScriptsCheck.run(context)).resolves.toEqual([])
	})

	test("reports a tracked file under scripts/ and a workflow step that runs one", async () => {
		const context = await collectRepoContext()
		const planted = { ...context, trackedFiles: [...context.trackedFiles, "scripts/stray.ts"] }
		const diagnostics = await noRootScriptsCheck.run(planted)

		expect(diagnostics.map((d) => d.file)).toContain("scripts/stray.ts")
	})
})

describe("the locale registers", () => {
	test("Scope.config.json names the same countries per tier as SCOPE.mdx, and places every shipping locale", async () => {
		const context = await collectRepoContext()

		await expect(localeScopeCheck.run(context)).resolves.toEqual([])
	})

	test("Every country→locale table agrees with the locales release.config.json ships", async () => {
		const context = await collectRepoContext()

		await expect(localeTablesCheck.run(context)).resolves.toEqual([])
	})
})

describe("the stylesheet interface", () => {
	test("the design system's resets are present and no rule leaves an interactive surface uncolored", async () => {
		const context = await collectRepoContext()

		await expect(stylesheetCheck.run(context)).resolves.toEqual([])
	})
})
