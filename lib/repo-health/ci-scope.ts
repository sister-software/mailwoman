/**
 * Selects CI suites from changed workspaces and their transitive consumers.
 *
 * Workspace files include fixtures, assets, and configuration.
 * Global changes select every suite.
 *
 * Manifest changes also select every suite because the current graph cannot describe removed edges.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { dirname, relative, resolvePath } from "path-ts"
import ts from "typescript"

/**
 * A workspace records the dependencies used to select its consumers.
 */
export interface CIWorkspace {
	name: string
	directory: string
	dependencies: string[]
	externalInputs?: string[]
}

/**
 * A selection records the tests and jobs required by a change.
 */
export interface CIScope {
	full: boolean
	reasons: string[]
	affected: string[]
	fastFiles: string[]
	slowFiles: string[]
	fast: boolean
	slow: boolean
	earth: boolean
	react: boolean
	planetary: boolean
	/**
	 * The browser tests of the private opportunity map application.
	 */
	opportunity: boolean
	worker: boolean
	smoke: boolean
	lexicon: boolean
	docs: boolean
	python: boolean
}

/**
 * Finds the workspace containing a repository-relative path.
 */
function workspaceForFile(file: string, workspaces: readonly CIWorkspace[]): CIWorkspace | undefined {
	return workspaces.find((workspace) => file.startsWith(`${workspace.directory}/`))
}

/**
 * Identifies tests excluded by the root Vitest configuration.
 */
function excludedFromRootTests(file: string): boolean {
	return /(?:^|\/)(?:react|license-worker)\/|\/(?:examples|cypress|out|dist)\/|\/(?:test\/browser|test\/e2e)\/|^docs\/test\/build\//u.test(
		file
	)
}

/**
 * Reads manifest dependencies and literal source imports, including imports in tests.
 */
export async function readCIWorkspaces(repoRoot: string, files: readonly string[]): Promise<CIWorkspace[]> {
	const directories = await readWorkspaceDirectories(repoRoot)

	const workspaces = await Promise.all(
		directories.map(async (directory): Promise<CIWorkspace> => {
			const manifest = await readPackageJSON(resolvePath(repoRoot, directory, "package.json"))

			if (!manifest.name) throw new Error(`Workspace ${directory} has no name`)

			return {
				name: manifest.name,
				directory,
				externalInputs: [],
				dependencies: Object.keys({
					...manifest.dependencies,
					...manifest.devDependencies,
					...manifest.peerDependencies,
					...manifest.optionalDependencies,
				}),
			}
		})
	)

	const names = new Set(workspaces.map((workspace) => workspace.name))

	if (names.size !== workspaces.length) throw new Error("Workspace names are not unique")

	const queue = files.filter((file) => /\.[cm]?[jt]sx?$/u.test(file) && workspaceForFile(file, workspaces))

	await Promise.all(
		Array.from({ length: 8 }, async () => {
			for (let file = queue.shift(); file; file = queue.shift()) {
				const owner = workspaceForFile(file, workspaces)!

				const source = ts.createSourceFile(
					file,
					await readLocalTextFile(resolvePath(repoRoot, file)),
					ts.ScriptTarget.Latest,
					true
				)

				const addImport = (specifier: string): void => {
					const dependency = specifier.startsWith(".")
						? workspaceForFile(relative(repoRoot, resolvePath(repoRoot, dirname(file), specifier)), workspaces)?.name
						: workspaces.find((workspace) => specifier === workspace.name || specifier.startsWith(`${workspace.name}/`))
								?.name

					if (dependency && dependency !== owner.name && !owner.dependencies.includes(dependency)) {
						owner.dependencies.push(dependency)
					}
				}

				const visit = (node: ts.Node): void => {
					// Python scripts and fixture files can be consumed without a module import.
					// A literal directory selects all changes below it when a narrower path is unavailable.
					if (ts.isStringLiteral(node) && /^corpus-python(?:\/|$)/u.test(node.text)) {
						let input = node.text

						if (
							ts.isCallExpression(node.parent) &&
							ts.isIdentifier(node.parent.expression) &&
							["repoRootPath", "resolvePath", "join"].includes(node.parent.expression.text)
						) {
							const argumentsAfter = node.parent.arguments.slice(node.parent.arguments.indexOf(node) + 1)

							for (const argument of argumentsAfter) {
								if (!ts.isStringLiteral(argument)) break
								input += `/${argument.text}`
							}
						}

						owner.externalInputs!.push(input)
					}

					if (
						(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
						node.moduleSpecifier &&
						ts.isStringLiteral(node.moduleSpecifier)
					) {
						addImport(node.moduleSpecifier.text)
					}

					if (
						ts.isCallExpression(node) &&
						(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
							(ts.isIdentifier(node.expression) && node.expression.text === "require"))
					) {
						const argument = node.arguments[0]

						if (argument && ts.isStringLiteral(argument)) {
							addImport(argument.text)
						}
					}

					ts.forEachChild(node, visit)
				}

				visit(source)
			}
		})
	)

	return workspaces
}

/**
 * Computes the suites affected by a diff without executing tests.
 */
export function selectCIScope(
	workspaces: readonly CIWorkspace[],
	files: readonly string[],
	changed: readonly string[],
	published: readonly string[],
	forceFull = false
): CIScope {
	const reasons: string[] = forceFull ? ["The event requires every suite."] : []
	const affected = new Set<string>()
	let python = forceFull

	for (const file of changed) {
		const owner = workspaceForFile(file, workspaces)

		if (file.startsWith("corpus-python/") || file.endsWith(".py")) {
			python = true
		}

		if (file.startsWith("corpus-python/")) {
			for (const workspace of workspaces) {
				if (workspace.externalInputs?.some((input) => file === input || file.startsWith(`${input}/`))) {
					affected.add(workspace.name)
				}
			}

			continue
		}

		if (!owner || file === `${owner.directory}/package.json` || file === `${owner.directory}/AGENTS.md`) {
			reasons.push(`The change to ${file} requires every suite.`)

			continue
		}

		affected.add(owner.name)
	}

	const full = reasons.length > 0

	if (full) {
		for (const workspace of workspaces) {
			affected.add(workspace.name)
		}

		python = true
	} else {
		// The queue terminates when every consumer has been visited, including dependency cycles.
		const queue = [...affected]

		for (let dependency = queue.shift(); dependency; dependency = queue.shift()) {
			for (const workspace of workspaces) {
				if (workspace.dependencies.includes(dependency) && !affected.has(workspace.name)) {
					affected.add(workspace.name)
					queue.push(workspace.name)
				}
			}
		}
	}

	const selected = files.filter((file) => full || affected.has(workspaceForFile(file, workspaces)?.name ?? ""))

	const fastFiles = selected
		.filter((file) => {
			if (!/\.(?:test|spec)\.tsx?$/u.test(file) || /\.(?:integration|full)\.test\.tsx?$/u.test(file)) return false

			if (!file.includes("/")) return true

			if (!/^(?:packages\/[^/]+|docs)\//u.test(file) || !/\.test\.tsx?$/u.test(file)) return false

			return !excludedFromRootTests(file)
		})
		.toSorted()

	const slowFiles = selected
		.filter((file) => /^packages\/[^/]+\/.*\.integration\.test\.tsx?$/u.test(file) && !excludedFromRootTests(file))
		.toSorted()

	const has = (name: string): boolean => full || affected.has(name)

	const affectedDirectories = workspaces
		.filter((workspace) => affected.has(workspace.name))
		.map((workspace) => workspace.directory)
		.toSorted()

	return {
		full,
		reasons,
		affected: affectedDirectories,
		fastFiles,
		slowFiles,
		fast: full || fastFiles.length > 0,
		slow: full || slowFiles.length > 0,
		earth: has("@mailwoman/earth"),
		react: has("@mailwoman/react"),
		planetary: has("@mailwoman/planetary"),
		opportunity: has("@mailwoman/opportunity-app"),
		worker: has("@mailwoman/license-worker"),
		smoke:
			full ||
			affectedDirectories.some((directory) => published.includes(directory)) ||
			has("@mailwoman/universe/release-kit") ||
			has("@mailwoman/universe/ops-cli") ||
			has("@mailwoman/universe/release-mcp"),
		lexicon: has("mailwoman") || has("@mailwoman/codex"),
		docs: has("@mailwoman/docs"),
		python,
	}
}
