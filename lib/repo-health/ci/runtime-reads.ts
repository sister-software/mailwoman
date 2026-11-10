/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The repository files a module may read at runtime, outside its import graph, as `ci-scope` needs them.
 *
 *   Vitest's import graph selects a test when a module it imports changes. A test can also depend on a file it never
 *   imports: a fixture it reads, a source tree a check scans, a script a child process runs. This module states that
 *   second kind of dependency for one source, from its effect edges, so a test is selected when a file it may read
 *   changes rather than whenever its workspace is affected.
 */

import { basename, isAbsolute, normalize, relative } from "path-ts"
import ts from "typescript"

import { type EffectEdge, extractEffectEdges } from "#repo-health/effects/extract"
import { EffectKind, PathRoot } from "#repo-health/effects/interfaces"
import { extractPathMentions } from "#repo-health/effects/mentions"
import type { ImportedPaths, ResolvedTarget } from "#repo-health/effects/resolve"

/**
 * What one module may read at runtime.
 */
export interface RuntimeReads {
	/**
	 * Why the module may read any file, or `null` when every runtime read it makes resolves.
	 */
	unbounded: string | null
	/**
	 * The repository-relative files and directories it reads.
	 * `""` stands for the whole repository.
	 */
	paths: string[]
	/**
	 * The repository-relative paths whose own metadata it reads, through a stat,
	 * a size, a link or a real path.
	 *
	 * A change matches one of these only when it changes that path itself.
	 */
	exact: string[]
	/**
	 * Whether it reads under the data root.
	 * Only a `mailwoman-data` runner holds the data root.
	 */
	dataRoot: boolean
}

/**
 * The Node builtins a module reaches the filesystem or child processes through without an effect interface.
 * Core's own wrappers are the expected importers.
 */
const RAW_EFFECT_MODULES = /^node:(?:fs|child_process|sqlite)(?:\/|$)/u

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u

export function isTestSource(file: string): boolean {
	return TEST_FILE.test(file)
}

/**
 * The reason a module may load or reach any file through its imports, or `null`
 * when its imports state each target.
 *
 * A raw builtin import counts only in a test.
 * In library code the lint rules confine those builtins to core's wrappers.
 * Those wrappers act on the paths their callers pass.
 */
function unboundedImport(source: ts.SourceFile, test: boolean): string | null {
	let reason: string | null = null

	const visit = (node: ts.Node): void => {
		if (reason) return

		if (
			test &&
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			RAW_EFFECT_MODULES.test(node.moduleSpecifier.text)
		) {
			reason = `imports ${node.moduleSpecifier.text}`

			return
		}

		const loads =
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require"))

		if (loads) {
			const [specifier] = node.arguments

			if (!specifier || !ts.isStringLiteralLike(specifier)) {
				reason = "loads a module by a computed specifier"

				return
			}

			if (test && RAW_EFFECT_MODULES.test(specifier.text)) {
				reason = `loads ${specifier.text}`

				return
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return reason
}

/**
 * The repository-relative path a resolved target names, `null` when it names no
 * repository file, or `"data-root"` when it is under the data root.
 *
 * A relative literal resolves against the repository root, where every root Vitest suite runs.
 */
function repositoryPathOf(
	target: ResolvedTarget,
	repoRoot: string,
	packageDirectories: ReadonlyMap<string, string>
): string | null | "data-root" {
	switch (target.root) {
		case PathRoot.Repository:
			return normalizeRepositoryPath(target.path)
		case PathRoot.DataRoot:
			return "data-root"
		case PathRoot.Literal: {
			if (target.path.includes("://")) return null

			if (!isAbsolute(target.path)) return normalizeRepositoryPath(target.path)

			const inside = relative(repoRoot, target.path).toString()

			return inside.startsWith("..") || isAbsolute(inside) ? null : normalizeRepositoryPath(inside)
		}
		case PathRoot.Package: {
			const segments = target.path.split("/")
			const nameLength = segments[0]?.startsWith("@") ? 2 : 1
			const directory = packageDirectories.get(segments.slice(0, nameLength).join("/"))

			// A package outside the workspaces is installed under `node_modules` rather than tracked.
			return directory ? normalizeRepositoryPath([directory, ...segments.slice(nameLength)].join("/")) : null
		}
		default:
			return null
	}
}

function normalizeRepositoryPath(path: string): string {
	if (path === "" || path === ".") return ""

	return normalize(path).toString().replace(/^\.\//u, "").replace(/\/+$/u, "")
}

/**
 * The commands that run repository code, so a child process running one may load any module in the checkout.
 */
const CODE_RUNNERS = new Set(["node", "yarn", "npm", "npx", "pnpm", "tsx", "bun", "deno", "sh", "bash", "zsh"])

/**
 * Whether an edge may let the module reach a file it does not name.
 *
 * A child process that runs repository code may load any module, in a test or in library code.
 * In a test, a command that does not resolve may be such a process.
 *
 * In library code it is one the caller supplies, as `chunk-process.ts` runs the script
 * its caller passes, and the caller's own edges and built paths account for it.
 *
 * An unresolved read leaves a test unbounded.
 * In library code it reads a path its caller supplies, and the caller's own reads
 * and built paths account for that path.
 */
function unboundedEdge(edge: EffectEdge, test: boolean): string | null {
	if (edge.kind === EffectKind.Process) {
		const command = edge.target ? basename(edge.target.path).toString() : null

		if (command === null) return test ? `runs ${edge.unresolved}` : null

		return CODE_RUNNERS.has(command) ? `runs ${command}` : null
	}

	if (test && edge.kind === EffectKind.Read && !edge.target) return `reads ${edge.unresolved}`

	return null
}

export interface RuntimeReadOptions {
	repoRoot: string
	/**
	 * Each workspace's directory by its package name.
	 */
	packageDirectories: ReadonlyMap<string, string>
	importedPaths: ImportedPaths | null
}

/**
 * What `source` may read at runtime, or `null` when it reads no file outside its imports.
 *
 * Its reads include every rooted path it builds, because a module passes such a path to the code it calls.
 * `collectRepoContext()` builds the repository root as its parameter's default, for one.
 */
export function summarizeRuntimeReads(
	source: ts.SourceFile,
	file: string,
	options: RuntimeReadOptions
): RuntimeReads | null {
	const test = isTestSource(file)
	const edges = extractEffectEdges(source, file, options.importedPaths)
	let unbounded = unboundedImport(source, test)
	const paths = new Set<string>()
	const exact = new Set<string>()
	let dataRoot = false

	const add = (target: ResolvedTarget, into: Set<string>): void => {
		const path = repositoryPathOf(target, options.repoRoot, options.packageDirectories)

		if (path === "data-root") {
			dataRoot = true
		} else if (path !== null) {
			into.add(path)
		}
	}

	for (const edge of edges) {
		unbounded ??= unboundedEdge(edge, test)

		if (edge.kind === EffectKind.Read && edge.target) {
			add(edge.target, edge.exact ? exact : paths)
		}
	}

	for (const target of extractPathMentions(source, file, options.importedPaths)) {
		add(target, paths)
	}

	for (const path of paths) {
		exact.delete(path)
	}

	if (!unbounded && !paths.size && !exact.size && !dataRoot) return null

	return { unbounded, paths: [...paths].toSorted(), exact: [...exact].toSorted(), dataRoot }
}

const MODULE_FILE = /\.[cm]?[jt]sx?$/u

/**
 * Whether a module with `reads` may read one of the `changed` repository-relative files.
 *
 * A source module among its reads is one it may run as well as read,
 * and running it loads that module's imports.
 * The workspace graph closes over those imports, so such a read matches whenever the
 * module's workspace is among the `affected` workspace directories.
 */
export function readsAnyOf(reads: RuntimeReads, changed: readonly string[], affected: readonly string[]): boolean {
	if (reads.unbounded) return true

	if (reads.exact.some((path) => changed.includes(path))) return true

	return reads.paths.some(
		(path) =>
			path === "" ||
			changed.some((file) => file === path || file.startsWith(`${path}/`)) ||
			(MODULE_FILE.test(path) && affected.some((directory) => path.startsWith(`${directory}/`)))
	)
}
