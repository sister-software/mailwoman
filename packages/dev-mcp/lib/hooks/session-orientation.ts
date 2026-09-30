#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SessionStart hook that lists each workspace and its export subpaths.
 *
 *   The listing omits signatures to stay small. `mwdev_symbol` answers the details. The hook swallows every
 *   error so a failure never blocks a session from starting.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { repoRootPath } from "@mailwoman/core/paths"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { type PathBuilderLike, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * The number of subpaths listed per workspace.
 * The listing counts the rest.
 */
const SUBPATH_LIMIT = 12

const LIB_PATTERN_TARGET = "./lib/*.ts"
const LISTED_MODULE = /^(?!.*\.(?:test|d)\.ts$).+\.ts$/u

/**
 * Returns the subpaths in a manifest's `exports` map, excluding `./package.json`.
 *
 * A `"./*"` pattern over `lib/` is expanded into the modules it resolves,
 * shallowest first, after the explicit keys.
 * Any other pattern is left out because its matches cannot be listed from the key.
 */
async function exportedSubpaths(packageDirectory: PathBuilderLike, exports: unknown): Promise<string[]> {
	if (typeof exports !== "object" || exports === null) return []

	const map = exports as Record<string, unknown>
	const explicit = Object.keys(map).filter((subpath) => subpath !== "./package.json" && !subpath.includes("*"))
	const pattern = map["./*"]
	const target = typeof pattern === "object" && pattern !== null ? (pattern as { node?: unknown }).node : pattern

	if (target !== LIB_PATTERN_TARGET) return explicit

	const modules = (
		await Globerator.from("**/*.ts", { cwd: resolvePath(packageDirectory, "lib"), onlyFiles: true }).toArray()
	)
		.map((file) => file.toString())
		.filter((file) => LISTED_MODULE.test(file) && file !== "index.ts")
		.map((file) => `./${file.replace(/\.ts$/u, "")}`)
		.toSorted((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))

	return [...new Set([...explicit, ...modules])]
}

/**
 * Builds the listing, with one line per workspace giving its package name and export subpaths.
 *
 * Returns an empty string when no workspace manifest has a `name` field.
 */
export async function orientationListing(repoRoot: PathBuilderLike): Promise<string> {
	const lines: string[] = []

	for (const directory of await readWorkspaceDirectories(repoRoot)) {
		const manifest = await readPackageJSON(resolvePath(repoRoot, directory, "package.json")).catch(() => null)

		if (!manifest?.name) continue

		const subpaths = await exportedSubpaths(resolvePath(repoRoot, directory), manifest.exports)
		const shown = subpaths.slice(0, SUBPATH_LIMIT)
		const rest = subpaths.length - shown.length
		const scope = manifest.private ? " (private)" : ""

		lines.push(`${manifest.name}${scope}: ${shown.length ? shown.join(" ") : "—"}${rest > 0 ? ` +${rest} more` : ""}`)
	}

	if (!lines.length) return ""

	return [
		`The ${lines.length} workspaces in this repository and the subpaths each one exports. This says where to look, ` +
			"not what is there: ask `mwdev_symbol` with `query` for a name fragment, or with `describes` for what a thing " +
			"does, before writing a helper.",
		"",
		...lines,
	].join("\n")
}

async function main(): Promise<void> {
	const additionalContext = await orientationListing(repoRootPath())

	if (!additionalContext) return

	process.stdout.write(stringifyJSON({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }))
}

try {
	await main()
} catch {
	// A session without orientation is better than one that fails to start.
}
