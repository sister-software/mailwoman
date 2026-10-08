/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A module that declares exports of its own does not also re-export another workspace module's names. A
 *   re-export there gives each re-exported declaration a second home, so importers drift between the two and the
 *   defining module stops being the one place to look. Only a directory barrel re-exports: a package's `index.ts`, the
 *   `<dir>.ts` beside a `<dir>/` directly under a source root, and the `<dir>/<dir>.ts` a `./<dir>` subpath maps to.
 *   A file whose only exports are re-exports is a barrel by construction and is not reported.
 *
 *   A re-export from an external package (`node:*`, `kysely`, …) is a facade the import rules point callers at,
 *   so it is allowed anywhere.
 */

import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#repo-health/check"
import { parseContextSource, readContextSources } from "#repo-health/context"
import { PACKAGE_SOURCE_GLOBS, trackedSourcePaths } from "#repo-health/tracked-sources"

const CHECK_ID = "module-reexports"

/**
 * Barrels whose subpath name differs from their path, each with the export that names it.
 */
const NAMED_BARRELS: ReadonlyMap<string, string> = new Map([
	["packages/neural/lib/onnx/runner.ts", "`@mailwoman/neural/onnx-runner`"],
])

/**
 * One internal re-export in a module that also declares its own exports.
 */
export interface ModuleReexport {
	file: string
	line: number
	specifier: string
}

const isInternalSpecifier = (specifier: string): boolean => specifier.startsWith("#") || specifier.startsWith(".")

/**
 * The source root a repo-relative path sits under: `packages/<p>/<root>` or `lib/<workspace>`.
 */
function sourceRootOf(file: string): string | null {
	return SOURCE_ROOT.exec(file)?.groups?.["root"] ?? null
}

/**
 * A workspace source root (`packages/<p>/<root>/`) or a root-package workspace (`lib/<workspace>/`).
 */
const SOURCE_ROOT = /^(?<root>packages\/[^/]+\/[^/]+|lib\/[^/]+)\//u

/**
 * Whether `file` is a directory barrel, given the tracked directories.
 */
export function isBarrelModule(file: string, trackedDirectories: ReadonlySet<string>): boolean {
	if (NAMED_BARRELS.has(file)) return true

	const slash = file.lastIndexOf("/")
	const directory = file.slice(0, slash)
	const stem = file.slice(slash + 1).replace(/\.tsx?$/u, "")

	if (stem === "index") return true

	// `<dir>/<dir>.ts`, the module a `./<dir>` subpath names.
	if (directory.slice(directory.lastIndexOf("/") + 1) === stem) return true

	// `<dir>.ts` beside `<dir>/`, directly under a source root.
	return sourceRootOf(file) === directory && trackedDirectories.has(`${directory}/${stem}`)
}

/**
 * The internal re-exports of one parsed module, or none when the module declares no exports of its own.
 */
export function moduleReexports(file: string, source: ts.SourceFile): ModuleReexport[] {
	const reexports: ModuleReexport[] = []
	let ownExports = false

	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement)) {
			const specifier =
				statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
					? statement.moduleSpecifier.text
					: null

			if (specifier === null) {
				ownExports = true
			} else if (isInternalSpecifier(specifier)) {
				const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source))

				reexports.push({ file, line: line + 1, specifier })
			}

			continue
		}

		if (ts.isExportAssignment(statement)) {
			ownExports = true

			continue
		}

		if (
			ts.canHaveModifiers(statement) &&
			(ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
		) {
			ownExports = true
		}
	}

	return ownExports ? reexports : []
}

/**
 * Every internal re-export in a module that is neither a directory barrel nor a pure barrel.
 */
async function findModuleReexports(context: RepoContext): Promise<ModuleReexport[]> {
	const paths = await trackedSourcePaths(context, { globs: PACKAGE_SOURCE_GLOBS, existingOnly: true })
	const trackedDirectories = new Set<string>()

	for (const file of context.trackedFiles) {
		for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) {
			trackedDirectories.add(file.slice(0, slash))
		}
	}

	const read = paths.filter((path) => {
		const file = relative(context.repoRoot, path)

		return !file.endsWith(".d.ts") && !isBarrelModule(file, trackedDirectories)
	})

	await readContextSources(context, read)

	const found: ModuleReexport[] = []

	for (const path of read) {
		found.push(...moduleReexports(relative(context.repoRoot, path), await parseContextSource(context, path)))
	}

	return found.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/**
 * The `module-reexports` check: an error for each internal re-export outside a barrel.
 */
export const moduleReexportsCheck: RepoCheck = {
	id: CHECK_ID,
	description: "Only a directory barrel or a pure barrel re-exports another workspace module's names.",
	async run(context) {
		return (await findModuleReexports(context)).map((site): Diagnostic => ({
			severity: DiagnosticSeverity.Error,
			file: site.file,
			line: site.line,
			message:
				`${site.file} declares its own exports and also re-exports ${site.specifier}. Delete the re-export and ` +
				"import those names from the module that declares them. A public name belongs in the package's barrel.",
			details: null,
		}))
	},
}
