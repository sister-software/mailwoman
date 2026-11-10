/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The effect edges of every tracked TypeScript source, tests included, and the count of them that resolve. A test's reads
 *   are what test selection by file needs, so the tests are part of the census rather than excluded from it.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { relative, resolvePath } from "path-ts"
import { parallelMap } from "spliterator"

import type { RepoContext } from "#repo-health/check"
import { parseContextSource } from "#repo-health/context"
import { type EffectEdge, extractEffectEdges } from "#repo-health/effects/extract"
import type { EffectKind } from "#repo-health/effects/interfaces"
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
 * The effect edges of every tracked `.ts` and `.tsx` source in `context`.
 */
async function collectEffectCensus(context: RepoContext): Promise<EffectCensus> {
	const paths = await trackedSourcePaths(context, { existingOnly: true })

	const perFile = await parallelMap(paths, async (path) => {
		const source = await parseContextSource(context, path, { setParentNodes: true })

		return extractEffectEdges(source, relative(context.repoRoot, path).toString())
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
