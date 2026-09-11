/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reports implementation modules whose top-level declaration surface hides multiple responsibilities.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * Per-module declaration and divider limits that trigger a structural review warning.
 */
export const MODULE_SURFACE_THRESHOLDS = {
	interfaces: 15,
	constants: 30,
	functions: 20,
	lines: 500,
	sectionDividers: 6,
} as const

export interface ModuleSurface {
	interfaces: number
	constants: number
	functions: number
	lines: number
	sectionDividers: number
}

interface SurfaceHit {
	metric: keyof ModuleSurface
	count: number
	line: number
}

const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx)$/u
/**
 * A closed divider comment in either rule character, ASCII or box-drawing: `// -- label ---` and `// ── label ───`.
 * Both runs are two characters or longer, and a comment whose text continues on the next line carries no trailing run
 * and is not a divider.
 */
const SECTION_DIVIDER = /^\s*\/\/\s*[-─]{2,}\s+[^\n]+[-─]{2,}\s*$/gmu

const METRIC_LABEL: Record<keyof ModuleSurface, string> = {
	interfaces: "interfaces",
	constants: "const declarations",
	functions: "functions",
	lines: "lines",
	sectionDividers: "section-divider comments",
}

/**
 * Count declarations directly owned by a source file. Nested callbacks, local constants, and declarations inside a
 * namespace do not add to the module's public reading surface.
 */
export function moduleSurface(sourceFile: ts.SourceFile): ModuleSurface {
	const surface: ModuleSurface = { interfaces: 0, constants: 0, functions: 0, lines: 0, sectionDividers: 0 }

	for (const statement of sourceFile.statements) {
		if (ts.isInterfaceDeclaration(statement)) {
			surface.interfaces++
		}

		if (ts.isFunctionDeclaration(statement)) {
			surface.functions++
		}

		if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
			surface.constants += statement.declarationList.declarations.length
		}
	}

	surface.sectionDividers = [...sourceFile.text.matchAll(SECTION_DIVIDER)].length
	surface.lines = sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1

	return surface
}

function surfaceHits(sourceFile: ts.SourceFile, surface: ModuleSurface): SurfaceHit[] {
	const firstLine: Partial<Record<keyof ModuleSurface, number>> = {}
	let interfaces = 0
	let constants = 0
	let functions = 0
	const lines = sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1

	if (lines >= MODULE_SURFACE_THRESHOLDS.lines) {
		firstLine.lines = MODULE_SURFACE_THRESHOLDS.lines
	}

	for (const statement of sourceFile.statements) {
		const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1

		if (ts.isInterfaceDeclaration(statement)) {
			interfaces++

			if (interfaces === MODULE_SURFACE_THRESHOLDS.interfaces) {
				firstLine.interfaces = line
			}
		}

		if (ts.isFunctionDeclaration(statement)) {
			functions++

			if (functions === MODULE_SURFACE_THRESHOLDS.functions) {
				firstLine.functions = line
			}
		}

		if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
			constants += statement.declarationList.declarations.length

			if (constants >= MODULE_SURFACE_THRESHOLDS.constants && firstLine.constants === undefined) {
				firstLine.constants = line
			}
		}
	}

	SECTION_DIVIDER.lastIndex = 0
	const divider = SECTION_DIVIDER.exec(sourceFile.text)

	if (divider?.index !== undefined) {
		firstLine.sectionDividers = sourceFile.getLineAndCharacterOfPosition(divider.index).line + 1
	}

	SECTION_DIVIDER.lastIndex = 0

	return (Object.entries(MODULE_SURFACE_THRESHOLDS) as [keyof ModuleSurface, number][])
		.filter(([metric, threshold]) => surface[metric] >= threshold)
		.map(([metric]) => ({ metric, count: surface[metric], line: firstLine[metric] ?? 1 }))
}

/**
 * AST-backed reading-surface heuristic. Warnings name the declaration kind that crossed its threshold; they do not
 * claim a decomposition boundary on the checker's behalf.
 */
export const moduleSurfaceCheck: RepoCheck = {
	id: "module-surface",
	description:
		"Warn when a package implementation module accumulates many top-level interfaces, constants, functions, or section-divider comments.",
	async run(context: RepoContext): Promise<Diagnostic[]> {
		const diagnostics: Diagnostic[] = []

		for (const filePath of await trackedSourcePaths(context, { prefix: "packages/", existingOnly: true })) {
			const file = relative(context.repoRoot, filePath)

			if (!file.includes("/lib/") || TEST_FILE.test(file)) continue

			const sourceFile = ts.createSourceFile(filePath, await readLocalTextFile(filePath), ts.ScriptTarget.Latest, true)
			const surface = moduleSurface(sourceFile)

			for (const hit of surfaceHits(sourceFile, surface)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					message: `${hit.count} top-level ${METRIC_LABEL[hit.metric]} (threshold ${MODULE_SURFACE_THRESHOLDS[hit.metric]}); inspect whether a source, locale, or responsibility can move into its own module`,
					file,
					line: hit.line,
				})
			}
		}

		return diagnostics
	},
}
