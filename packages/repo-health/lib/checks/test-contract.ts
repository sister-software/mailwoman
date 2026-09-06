/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Enforce tests as external consumers of workspace package contracts.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { dirname, relative, resolvePath, sep } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"
import { moduleSpecifiers } from "#ts-ast"

interface RootManifest {
	workspaces: string[]
}

const testPattern = /\.(?:test|spec)\.(?:ts|tsx)$/u
const packageSuites = new Set(["full", "integration", "unit"])
const docsSuites = new Set([...packageSuites, "browser", "build", "e2e"])

/**
 * The `test-contract` check: one error per test file outside `test/{unit,integration,full}/` and per relative import a
 * test makes.
 */
export const testContractCheck: RepoCheck = {
	id: "test-contract",
	description:
		"Every workspace test sits under test/{unit,integration,full}/ and imports the package by its contract; a relative import names a test helper only.",
	async run(context) {
		const root = context.repoRoot
		const manifest = await readLocalJSONFile<RootManifest>(resolvePath(root, "package.json"))
		const diagnostics: Diagnostic[] = []
		const sources = await trackedSourcePaths(context, { existingOnly: true })

		for (const workspace of manifest.workspaces) {
			const workspaceRoot = resolvePath(root, workspace)
			const isDocs = workspace === "docs"
			const allowedSuites = isDocs ? docsSuites : packageSuites

			for (const filePath of sources) {
				if (!filePath.startsWith(`${workspaceRoot}/`) || !testPattern.test(filePath)) continue

				const workspaceRelative = relative(workspaceRoot, filePath).split(sep)
				const file = relative(root, filePath)

				if (workspaceRelative[0] !== "test" || !allowedSuites.has(workspaceRelative[1] ?? "")) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: `tests belong under test/${isDocs ? "{unit,integration,full,browser,build,e2e}" : "{unit,integration,full}"}/`,
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
