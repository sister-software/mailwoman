import { collectRepoContext } from "@mailwoman/repo-health"
import { localeScopeCheck } from "@mailwoman/repo-health/checks/locale/scope"
import { localeTablesCheck } from "@mailwoman/repo-health/checks/locale/tables"
import { noRootScriptsCheck } from "@mailwoman/repo-health/checks/no-root-scripts"
import { nodeModulesReacharoundCheck } from "@mailwoman/repo-health/checks/node-modules-reacharound"
import { runtimeFlagsCheck } from "@mailwoman/repo-health/checks/runtime-flags"
import { stylesheetCheck } from "@mailwoman/repo-health/checks/stylesheet-check"
import { describe, expect, test } from "vitest"

describe("The node_modules reach-around condition", () => {
	test("Reports nothing on the current tree — neither hand-spelled layout outside the allowlist nor stale entry", async () => {
		const context = await collectRepoContext()

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
	test("Does not exist without code builds a path into it, and no CI target runs scripts/… or a bare lib/*.ts path", async () => {
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

describe("the locale registers", () => {
	test("Scope.config.json names the same countries per tier as SCOPE.mdx, and places every shipping locale", async () => {
		const context = await collectRepoContext()

		expect(await localeScopeCheck.run(context)).toEqual([])
	})

	test("Every country→locale table agrees with the locales release.config.json ships", async () => {
		const context = await collectRepoContext()

		expect(await localeTablesCheck.run(context)).toEqual([])
	})
})

describe("the stylesheet interface", () => {
	test("the design system's resets are present and no rule leaves an interactive surface uncolored", async () => {
		const context = await collectRepoContext()

		expect(await stylesheetCheck.run(context)).toEqual([])
	})
})
