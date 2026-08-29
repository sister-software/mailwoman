/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Guard for the scripts CI runs before `yarn install`.
 *
 *   Two workflow steps run `node <script>` against a checkout with no `node_modules`: the Docs
 *   workflow's structure check (early on purpose, so a frontmatter or orphan regression fails in
 *   seconds instead of after a full Docusaurus build) and the docs-freshness sweep, which never
 *   installs. Every module those entry points reach must resolve from the checkout alone — a relative
 *   path, or a `node:` builtin.
 *
 *   A local run cannot see the break. `node_modules` exists on a developer machine, so a workspace
 *   import added to one of these files resolves, passes review, and passes the fast suite. It fails
 *   only on CI, as `ERR_MODULE_NOT_FOUND`, which looks like a broken checkout.
 *
 *   So these files keep their `node:*` imports behind a scoped `typescript/no-restricted-imports`
 *   disable. The list below is the executable half of that exemption. Add an entry when a workflow
 *   starts running a script before its install step; remove one when that ordering changes.
 */

import { repoRootPath } from "@mailwoman/core/utils"
import { readFile } from "@mailwoman/platform/fs/promises"
import { dirname, join, relative, resolve } from "@mailwoman/platform/path"
import ts from "typescript"
import { describe, expect, test } from "vitest"

const REPO_ROOT = repoRootPath()

/**
 * Every script a workflow runs before (or without) `yarn install`, keyed by repo-relative path and carrying the step
 * that runs it. The graph reachable from each by relative import inherits the same constraint.
 */
const PRE_INSTALL_ENTRY_POINTS: Record<string, string> = {
	"docs/scripts/check-docs-structure.ts":
		".github/workflows/docs-build.yml — 'Docs structure checks', which runs before the 'Install dependencies' step",
	"docs/scripts/list-stale-docs.ts":
		".github/workflows/docs-freshness.yml — 'List pages past review-by'; that workflow has no install step at all",
}

/**
 * Every module specifier a source file imports, re-exports, or dynamically imports AT RUNTIME.
 *
 * Declaration-level `import type` / `export type` is skipped: Node's type stripping erases it, so the specifier is
 * never resolved and a package name there costs nothing. `docs/sidebars.ts` relies on this — it takes `SidebarsConfig`
 * from `@docusaurus/plugin-content-docs` as a type and runs fine with no install. A specifier-level `{ type Foo }`
 * still emits the declaration, so it is deliberately NOT skipped.
 */
function collectSpecifiers(filePath: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
	const specifiers: string[] = []

	const walk = (node: ts.Node): void => {
		// `phaseModifier` rather than the deprecated `isTypeOnly`: it also distinguishes `import defer`, which runs.
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
		) {
			specifiers.push(node.moduleSpecifier.text)
		}

		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			!node.isTypeOnly
		) {
			specifiers.push(node.moduleSpecifier.text)
		}

		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteral(node.arguments[0])
		) {
			specifiers.push(node.arguments[0].text)
		}

		ts.forEachChild(node, walk)
	}

	walk(sourceFile)

	return specifiers
}

/**
 * Walk the relative-import closure of one entry point, collecting every non-relative specifier it reaches along the
 * way. A specifier is reported with the file that spells it, so a failure names the edit to make.
 */
async function collectReachableExternals(entryPoint: string): Promise<Array<{ file: string; specifier: string }>> {
	const externals: Array<{ file: string; specifier: string }> = []
	const seen = new Set<string>()
	const queue = [resolve(REPO_ROOT, entryPoint)]

	while (queue.length) {
		const filePath = queue.pop()!

		if (seen.has(filePath)) continue
		seen.add(filePath)

		const source = await readFile(filePath, "utf8")

		for (const specifier of collectSpecifiers(filePath, source)) {
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
