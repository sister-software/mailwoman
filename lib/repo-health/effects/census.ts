// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The effect edges of every tracked TypeScript source, tests included,
 *   and the count of them that resolve.
 *
 *   A test's reads are what test selection by file needs, so the tests are part
 *   of the census rather than excluded from it.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { relative, resolvePath } from "path-ts"
import { parallelMap } from "spliterator"

import type { RepoContext } from "#repo-health/check"
import { parseContextSource } from "#repo-health/context"
import { type EffectEdge, extractEffectEdges } from "#repo-health/effects/extract"
import type { EffectKind } from "#repo-health/effects/interfaces"
import { type ImportedPaths, type RootedExport, summarizeRootedExports } from "#repo-health/effects/resolve"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * The resolved and unresolved edge counts of one workspace and edge kind.
 */
export interface EffectCensusRow {
	workspace: string
	kind: EffectKind
	resolved: number
	unresolved: number
}

export interface EffectCensus {
	sources: number
	edges: EffectEdge[]
	rows: EffectCensusRow[]
}

/**
 * The workspace a repository path belongs to: `packages/<name>`, or the first
 * path segment (`lib`, `docs`, …).
 */
export function censusGroupOf(file: string): string {
	const [first, second] = file.split("/")

	return first === "packages" && second ? `packages/${second}` : (first ?? file)
}

/**
 * The edges counted per workspace and kind, in workspace then kind order.
 */
export function summarizeEffectEdges(edges: readonly EffectEdge[]): EffectCensusRow[] {
	const rows = new Map<string, EffectCensusRow>()

	for (const edge of edges) {
		const workspace = censusGroupOf(edge.file)
		const key = `${workspace}\u0000${edge.kind}`
		let row = rows.get(key)

		if (!row) {
			row = { workspace, kind: edge.kind, resolved: 0, unresolved: 0 }
			rows.set(key, row)
		}

		if (edge.target) {
			row.resolved++
		} else {
			row.unresolved++
		}
	}

	return [...rows.values()].toSorted((a, b) => a.workspace.localeCompare(b.workspace) || a.kind.localeCompare(b.kind))
}

/**
 * A workspace's `paths` module, by its path relative to the repository root.
 */
const PATHS_MODULE = /^packages\/([^/]+)\/lib\/paths\.ts$/

/**
 * The resolved exports of every workspace's `lib/paths.ts`, by the workspace directory
 * that holds it, with the package name that `@mailwoman/<name>/paths` reaches it by.
 */
async function collectPathsModules(
	context: RepoContext,
	paths: readonly string[]
): Promise<Map<string, { packageName: string; exports: Map<string, RootedExport> }>> {
	const modules = new Map<string, { packageName: string; exports: Map<string, RootedExport> }>()

	for (const path of paths) {
		const file = relative(context.repoRoot, path).toString()
		const directory = PATHS_MODULE.exec(file)?.[1]

		if (!directory) continue

		const workspace = `packages/${directory}`
		const manifestPath = resolvePath(context.repoRoot, workspace, "package.json")
		const { name } = await readPackageJSON(manifestPath)

		if (!name) throw new Error(`${manifestPath} states no package name, so its paths module cannot be imported by one`)

		const source = await parseContextSource(context, path, { setParentNodes: true })

		modules.set(workspace, { packageName: name, exports: summarizeRootedExports(source, file) })
	}

	return modules
}

/**
 * For each file, the `paths` exports a specifier reaches from it: `#paths` reaches
 * the file's own workspace's module, and `@mailwoman/<name>/paths` reaches the
 * module of the workspace that publishes that name.
 */
function importedPathsResolver(
	modules: ReadonlyMap<string, { packageName: string; exports: Map<string, RootedExport> }>
): (file: string) => ImportedPaths {
	const byPackage = new Map([...modules.values()].map((module) => [`${module.packageName}/paths`, module.exports]))

	return (file) => {
		const own = modules.get(censusGroupOf(file))?.exports ?? null

		return (specifier) => (specifier === "#paths" ? own : (byPackage.get(specifier) ?? null))
	}
}

/**
 * For each repository-relative file in `context`, the `paths` exports its import specifiers reach.
 */
export async function readImportedPaths(context: RepoContext): Promise<(file: string) => ImportedPaths> {
	return importedPathsResolver(
		await collectPathsModules(context, await trackedSourcePaths(context, { existingOnly: true }))
	)
}

/**
 * The effect edges of every tracked `.ts` and `.tsx` source in `context`.
 */
async function collectEffectCensus(context: RepoContext): Promise<EffectCensus> {
	const paths = await trackedSourcePaths(context, { existingOnly: true })
	const importedPathsOf = importedPathsResolver(await collectPathsModules(context, paths))

	const perFile = await parallelMap(paths, async (path) => {
		const source = await parseContextSource(context, path, { setParentNodes: true })
		const file = relative(context.repoRoot, path).toString()

		return extractEffectEdges(source, file, importedPathsOf(file))
	}).toArray()

	const edges = perFile.flat()

	return { sources: paths.length, edges, rows: summarizeEffectEdges(edges) }
}

/**
 * Where `mwops effects` writes the edge file, under the repository's generated `out/` tree.
 */
export function effectCensusPath(repoRoot: string): string {
	return resolvePath(repoRoot, "out", "repo-health", "effects", "edges.json").toString()
}

/**
 * Collect the census and write its edges and rows to {@linkcode effectCensusPath}.
 */
export async function writeEffectCensus(context: RepoContext): Promise<EffectCensus> {
	const census = await collectEffectCensus(context)

	await writeLocalJSONFile(census, effectCensusPath(context.repoRoot))

	return census
}
