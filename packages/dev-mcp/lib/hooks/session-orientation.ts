#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SessionStart hook that lists each workspace and its export subpaths.
 *
 *   The listing omits signatures to stay small, and `mwdev_symbol` answers the details. The hook swallows every
 *   error so a failure never blocks a session from starting.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { repoRootPath } from "@mailwoman/core/paths"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { type PathBuilderLike, resolvePath } from "path-ts"

/**
 * The number of subpaths listed per workspace.
 * The listing counts the rest.
 */
const SUBPATH_LIMIT = 12

/**
 * Returns the subpaths in a manifest's `exports` map, excluding `./package.json` and wildcard patterns.
 */
function exportedSubpaths(exports: unknown): string[] {
	if (typeof exports !== "object" || exports === null) return []

	return Object.keys(exports as Record<string, unknown>).filter(
		(subpath) => subpath !== "./package.json" && !subpath.includes("*")
	)
}

/**
 * Builds the listing, with one line per workspace giving its package name and export subpaths.
 *
 * Returns an empty string when no workspace has a named manifest.
 */
export async function orientationListing(repoRoot: PathBuilderLike): Promise<string> {
	const lines: string[] = []

	for (const directory of await readWorkspaceDirectories(repoRoot)) {
		const manifest = await readPackageJSON(resolvePath(repoRoot, directory, "package.json")).catch(() => null)

		if (!manifest?.name) continue

		const subpaths = exportedSubpaths(manifest.exports)
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
