/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Enforce tests as external consumers of workspace package contracts.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/utils"
import { relative, resolve, sep } from "@mailwoman/platform/path"
import ts from "typescript"

interface RootManifest {
	workspaces: string[]
}

const root = String(repoRootPath())
const manifest = await readLocalJSONFile<RootManifest>(resolve(root, "package.json"))
const failures: string[] = []
const testPattern = /\.(?:test|spec)\.(?:ts|tsx)$/u
const packageSuites = new Set(["full", "integration", "unit"])
const docsSuites = new Set([...packageSuites, "browser", "build", "e2e"])

async function moduleSpecifiers(filePath: string): Promise<string[]> {
	const sourceText = await readLocalTextFile(filePath)
	const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
	const specifiers: string[] = []

	function visit(node: ts.Node): void {
		let specifier: ts.Expression | undefined

		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			specifier = node.moduleSpecifier
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			specifier = node.arguments[0]
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			specifier = node.argument.literal
		}

		if (specifier && ts.isStringLiteralLike(specifier)) {
			specifiers.push(specifier.text)
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)

	return specifiers
}

for (const workspace of manifest.workspaces) {
	const workspaceRoot = resolve(root, workspace)
	const isDocs = workspace === "docs"
	const allowedSuites = isDocs ? docsSuites : packageSuites

	for (const filePath of ts.sys.readDirectory(workspaceRoot, [".ts", ".tsx"], ["out", "node_modules"], ["**/*"])) {
		if (!testPattern.test(filePath)) continue

		const workspaceRelative = relative(workspaceRoot, filePath).split(sep)

		if (workspaceRelative[0] !== "test" || !allowedSuites.has(workspaceRelative[1] ?? "")) {
			failures.push(
				`${relative(root, filePath)}: tests belong under test/${isDocs ? "{unit,integration,full,browser,build,e2e}" : "{unit,integration,full}"}/`
			)
		}

		for (const specifier of await moduleSpecifiers(filePath)) {
			if (specifier.startsWith(".")) {
				failures.push(
					`${relative(root, filePath)}: relative module import ${JSON.stringify(specifier)} bypasses the package contract`
				)
			}
		}
	}
}

if (failures.length) {
	console.error(["Test contract verification failed:", ...failures.map((failure) => `  - ${failure}`)].join("\n"))

	process.exitCode = 1
} else {
	console.log("Test contract verified: package tests are isolated under test/ and use package/import-map specifiers.")
}
