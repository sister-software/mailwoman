/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `workspace:*` closure of a set of seed packages, computed from the manifests rather than copied into a list,
 *   and the pack step that turns a closure into `file:` tarball dependencies. Both clean-install smokes use these, so a
 *   fix to how a closure is walked or packed lands in one place; the un-awaited pack that broke the get-started harness
 *   had been fixed in the release smoke a day earlier because each carried its own copy.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { join, resolvePath } from "path-ts"

import { packWorkspaceForPublish } from "#pack/pack-workspace"

interface WorkspaceManifest {
	name: string
	dependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
}

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const

/**
 * Every workspace in the root `workspaces` array, keyed by package name, with its repo-relative directory.
 */
export async function workspaceDirectories(repoRoot: string): Promise<Map<string, string>> {
	const root = await readLocalJSONFile<{ workspaces: string[] }>(resolvePath(repoRoot, "package.json"))
	const byName = new Map<string, string>()

	for (const dir of root.workspaces) {
		const manifest = await readLocalJSONFile<WorkspaceManifest>(resolvePath(repoRoot, dir, "package.json"))

		byName.set(manifest.name, dir)
	}

	return byName
}

/**
 * The seeds plus every workspace they reach through a `workspace:` dependency, optional or peer dependency,
 * transitively — the set a consumer's `npm install` of the seeds pulls from the registry, computed so a package added
 * to a seed's graph is picked up without anyone editing a list. Throws when a seed or a reached dependency names no
 * workspace: a `workspace:` specifier that resolves nowhere is a broken manifest, not an absence.
 */
export async function walkWorkspaceClosure(repoRoot: string, seeds: readonly string[]): Promise<Map<string, string>> {
	const byName = await workspaceDirectories(repoRoot)
	const closure = new Map<string, string>()
	const queue = [...seeds]

	while (queue.length) {
		const name = queue.pop()!

		if (closure.has(name)) continue

		const dir = byName.get(name)

		if (!dir) throw new Error(`workspace closure: ${name} names no workspace in the root package.json`)

		closure.set(name, dir)

		const manifest = await readLocalJSONFile<WorkspaceManifest>(resolvePath(repoRoot, dir, "package.json"))

		for (const field of DEPENDENCY_FIELDS) {
			for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
				if (spec.startsWith("workspace:") && !closure.has(dependency)) {
					queue.push(dependency)
				}
			}
		}
	}

	return closure
}

/**
 * Pack each workspace into `tarDir` with the derived publish map and answer the `dependencies` block a throwaway
 * consumer project installs from — every entry a `file:` tarball, so nothing is resolved from the registry. Sequential
 * on purpose: each pack rewrites its own manifest while yarn reads its siblings.
 */
export async function packWorkspaces(
	repoRoot: string,
	workspaces: ReadonlyMap<string, string>,
	tarDir: string
): Promise<Record<string, string>> {
	const dependencies: Record<string, string> = {}

	for (const [name, dir] of workspaces) {
		const tarball = join(tarDir, `${dir}.tgz`)

		await packWorkspaceForPublish(resolvePath(repoRoot, dir), tarball)
		dependencies[name] = `file:${tarball}`
	}

	return dependencies
}
