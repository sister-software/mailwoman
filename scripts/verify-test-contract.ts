/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Enforce tests as external consumers of workspace package contracts.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { relative, resolvePath, sep } from "path-ts"
import ts from "typescript"

import { moduleSpecifiers } from "./ts-ast.ts"

interface RootManifest {
	workspaces: string[]
}

const root = String(repoRootPath())
const manifest = await readLocalJSONFile<RootManifest>(resolvePath(root, "package.json"))
const failures: string[] = []
const testPattern = /\.(?:test|spec)\.(?:ts|tsx)$/u
const packageSuites = new Set(["full", "integration", "unit"])
const docsSuites = new Set([...packageSuites, "browser", "build", "e2e"])

for (const workspace of manifest.workspaces) {
	const workspaceRoot = resolvePath(root, workspace)
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

		const sourceText = await readLocalTextFile(filePath)
		const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)

		// Type-only specifiers count here: tests are consumers of the package CONTRACT, types included.
		for (const specifier of moduleSpecifiers(sourceFile, { includeTypeOnly: true })) {
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
