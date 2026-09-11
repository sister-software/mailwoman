/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Enforce tests as external consumers of workspace package contracts.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { dirname, relative, resolvePath, sep } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"
import { moduleSpecifiers } from "#ts-ast"

const testPattern = /\.(?:test|spec)\.(?:ts|tsx)$/u
const vitestSuites = new Set(["full", "integration", "unit"])
const COLOCATED_TEST_WORKSPACES = new Set(["packages/corpus"])
/**
 * A workspace that carries a `playwright.config.ts` runs Playwright suites too, and those live beside the vitest ones:
 * `browser` for page specs, `build` for a build-health project, `e2e` for the fixtures they share. Vitest's root
 * configs exclude those directories, so the two runners never collect each other's files.
 */
const playwrightSuites = new Set([...vitestSuites, "browser", "build", "e2e"])

/**
 * The `test-contract` check: one error per test file outside its workspace's declared test layout and per relative
 * import a test makes. Corpus tests live next to their modules under `lib/`; other workspaces use
 * `test/{unit,integration,full}/`.
 */
export const testContractCheck: RepoCheck = {
	id: "test-contract",
	description:
		"Workspace tests use their declared layout and import the package by its contract; a relative import names a test helper only.",
	async run(context) {
		const root = context.repoRoot
		const diagnostics: Diagnostic[] = []
		const sources = await trackedSourcePaths(context, { existingOnly: true })

		for (const workspace of await readWorkspaceDirectories(root)) {
			const workspaceRoot = resolvePath(root, workspace)
			const colocatedTests = COLOCATED_TEST_WORKSPACES.has(workspace)
			const runsPlaywright = await pathExists(resolvePath(workspaceRoot, "playwright.config.ts"))
			const allowedSuites = runsPlaywright ? playwrightSuites : vitestSuites

			for (const filePath of sources) {
				if (!filePath.startsWith(`${workspaceRoot}/`) || !testPattern.test(filePath)) continue

				const workspaceRelative = relative(workspaceRoot, filePath).split(sep)
				const file = relative(root, filePath)

				const isInDeclaredLayout = colocatedTests
					? workspaceRelative[0] === "lib"
					: workspaceRelative[0] === "test" && allowedSuites.has(workspaceRelative[1] ?? "")

				if (!isInDeclaredLayout) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: colocatedTests
							? "corpus tests belong beside their modules under lib/"
							: `tests belong under test/${runsPlaywright ? "{unit,integration,full,browser,build,e2e}" : "{unit,integration,full}"}/`,
						file,
					})
				}

				const sourceText = await readLocalTextFile(filePath)
				const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)

				// Type-only specifiers count here: tests are consumers of the package CONTRACT, types included. A relative
				// specifier that stays inside `test/` names a test helper, which has no contract to bypass; one that leaves
				// `test/` reaches the package's source by location, and the `#` map is refused in tests by
				// `mailwoman/no-private-import-in-test`, so the module needs an `exports` entry instead.
				const testRoot = resolvePath(workspaceRoot, "test")

				for (const specifier of moduleSpecifiers(sourceFile, { includeTypeOnly: true })) {
					if (!specifier.startsWith(".")) continue

					const target = resolvePath(dirname(filePath), specifier)

					if (target.startsWith(`${testRoot}${sep}`)) continue

					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: `relative module import ${JSON.stringify(specifier)} leaves test/ and bypasses the package contract`,
						file,
					})
				}
			}
		}

		return diagnostics
	},
}
