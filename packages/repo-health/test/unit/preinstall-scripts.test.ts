/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Checks that scripts CI runs before `yarn install` import only relative paths and `node:` builtins.
 *
 *   A workspace import in these scripts resolves locally, where `node_modules` exists, and fails only on CI with
 *   `ERR_MODULE_NOT_FOUND`. Add an entry when a workflow starts running a script before its install step, and remove
 *   one when that order changes.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { moduleSpecifiers } from "@mailwoman/repo-health/ts-ast"
import { dirname, join, relative, resolvePath } from "path-ts"
import ts from "typescript"
import { describe, expect, test } from "vitest"

const REPO_ROOT = repoRootPath()

/**
 * Maps each script a workflow runs before or without `yarn install` to the workflow step that runs it.
 *
 * Every file reachable from these scripts by relative import has the same constraint.
 */
const PRE_INSTALL_ENTRY_POINTS: Record<string, string> = {
	"docs/scripts/check/docs-structure.ts":
		".github/workflows/docs-build.yml — 'Docs structure checks', which runs before the 'Install dependencies' step",
	"docs/scripts/list-stale-docs.ts":
		".github/workflows/docs-freshness.yml — 'List pages past review-by'; that workflow has no install step at all",
}

/**
 * Follows relative imports from one entry point and collects every non-relative
 * specifier with the file that imports it.
 */
async function collectReachableExternals(entryPoint: string): Promise<Array<{ file: string; specifier: string }>> {
	const externals: Array<{ file: string; specifier: string }> = []
	const seen = new Set<string>()
	const queue = [resolvePath(REPO_ROOT, entryPoint)]

	while (queue.length) {
		const filePath = queue.pop()!

		if (seen.has(filePath)) continue
		seen.add(filePath)

		const source = await readLocalTextFile(filePath)

		// `moduleSpecifiers` skips type-only imports by default, because Node's type stripping erases them.
		for (const specifier of moduleSpecifiers(ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true))) {
			if (!specifier.startsWith(".")) {
				externals.push({ file: relative(REPO_ROOT, filePath), specifier })

				continue
			}

			queue.push(join(dirname(filePath), specifier))
		}
	}

	return externals
}

describe("pre-install scripts", () => {
	for (const [entryPoint, runBy] of Object.entries(PRE_INSTALL_ENTRY_POINTS)) {
		test(`${entryPoint} reaches only node builtins (${runBy})`, async () => {
			const externals = await collectReachableExternals(entryPoint)
			const nonBuiltin = externals.filter(({ specifier }) => !specifier.startsWith("node:"))

			expect(nonBuiltin).toEqual([])
		})
	}
})
