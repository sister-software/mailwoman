/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every subpath must export the same names under Node and under the unsupported runtimes.
 *
 *   The two halves are separate hand-written files. Adding a name to `node/fs.ts` compiles, runs, and
 *   passes every Node test; the browser and worker conditions resolve `unsupported/fs.ts`, which does
 *   not have it, so the error appears only in a bundle, far from the file that caused it. Drift the
 *   other way ships a browser-only name that throws where the capability exists.
 *
 *   Types are compared as well as values. The packed manifest carries one `types` target per subpath,
 *   pointing at the unsupported declaration, so a Node consumer reads `unsupported/fs.d.ts` while
 *   running `node/fs.js`. That only works while the two declare the same names over the same types.
 *
 *   Hence the TypeScript checker rather than an import: `Object.keys` on a module namespace cannot see
 *   an erased type, so a value that lost its type-side name reads as parity when it is not.
 */

// An import attribute rather than a read-and-parse: the manifest resolves through the package's own exports, and a
// malformed one fails at load. Parsing it by hand would mean `parseJSONStrict` from `@mailwoman/core`, which would give
// `@mailwoman/platform` a first-party dependency in the wrong direction.
import manifest from "@mailwoman/platform/package.json" with { type: "json" }
import { dirname, resolve } from "@mailwoman/platform/path"
import { fileURLToPath } from "@mailwoman/platform/url"
import ts from "typescript"
import { describe, expect, test } from "vitest"

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.resolve("@mailwoman/platform/package.json")))

/**
 * The condition pair each subpath declares, read from the manifest rather than from the directory listing: the manifest
 * is what a consumer resolves, so a file present but unexported would otherwise look compliant.
 */
function readConditionPairs(): Array<{ subpath: string; node: string; unsupported: string }> {
	const pairs: Array<{ subpath: string; node: string; unsupported: string }> = []

	for (const [subpath, value] of Object.entries(manifest.exports)) {
		if (!value || typeof value !== "object") continue

		const conditions = value as Record<string, string>
		const nodeTarget = conditions["node"]
		const browserTarget = conditions["browser"]

		// A subpath with no browser condition (`.`, `./internal`) is platform-free by construction; nothing to compare.
		if (!nodeTarget || !browserTarget || nodeTarget === browserTarget) continue

		pairs.push({ subpath, node: nodeTarget, unsupported: browserTarget })
	}

	return pairs
}

/**
 * Every name a module exports, values and types alike, as the checker sees it.
 */
function exportedNames(program: ts.Program, filePath: string): string[] {
	const checker = program.getTypeChecker()
	const sourceFile = program.getSourceFile(filePath)

	if (!sourceFile) throw new Error(`export-parity: ${filePath} is not in the program`)

	const moduleSymbol = checker.getSymbolAtLocation(sourceFile)

	if (!moduleSymbol) throw new Error(`export-parity: ${filePath} has no module symbol`)

	return checker
		.getExportsOfModule(moduleSymbol)
		.map((symbol) => symbol.getName())
		.toSorted()
}

const pairs = readConditionPairs()

const program = ts.createProgram(
	pairs.flatMap(({ node, unsupported }) => [resolve(PACKAGE_ROOT, node), resolve(PACKAGE_ROOT, unsupported)]),
	{
		allowImportingTsExtensions: true,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		noEmit: true,
		target: ts.ScriptTarget.ESNext,
	}
)

describe("platform export parity", () => {
	test("every subpath declares both a Node and an unsupported target", () => {
		// A manifest that stopped declaring browser conditions would leave every case below with nothing to compare.
		expect(pairs.length).toBeGreaterThan(20)
	})

	for (const { subpath, node, unsupported } of pairs) {
		test(`${subpath} exports the same names from ${node} and ${unsupported}`, () => {
			expect(exportedNames(program, resolve(PACKAGE_ROOT, unsupported))).toEqual(
				exportedNames(program, resolve(PACKAGE_ROOT, node))
			)
		})
	}
})
