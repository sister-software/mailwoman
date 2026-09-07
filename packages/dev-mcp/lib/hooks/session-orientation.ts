#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SessionStart hook: which workspace owns which concern, and what each one exports, as one listing at the top of a
 *   session.
 *
 *   WHY THIS AND NOT MORE. An agent that does not know a package exists cannot ask `mwdev_symbol` about it, and the map
 *   from a concern to a workspace is the part AGENTS.md spends a table on and a session forgets first. The listing is
 *   the workspace NAMES and their export subpaths — an index of where to look, not what is there. The signatures were
 *   measured at roughly 88,000 tokens for this repository, which would displace the work it is meant to serve and
 *   would not survive a compaction; the names cost a fraction of that and point at a tool that answers the rest.
 *
 *   It fails silent and exits 0 on every error path. A session that cannot start because its orientation hook threw is
 *   a worse trade than a session that starts without orientation.
 */

import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { repoRootPath } from "@mailwoman/core/paths"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"

/**
 * How many subpaths a workspace contributes before the rest are counted instead. A handful names the concerns; the full
 * list of a large package is what `mwdev_symbol` is for, and the listing has to stay small enough to survive at the top
 * of a session.
 */
const SUBPATH_LIMIT = 12

/**
 * The subpaths a manifest's `exports` map declares, without the `./package.json` entry every workspace carries and
 * without the wildcard patterns, which name a shape rather than a concern.
 */
function exportedSubpaths(exports: unknown): string[] {
	if (typeof exports !== "object" || exports === null) return []

	return Object.keys(exports as Record<string, unknown>).filter(
		(subpath) => subpath !== "./package.json" && !subpath.includes("*")
	)
}

/**
 * One line per workspace: its package name, then the subpaths a consumer may import.
 */
export async function orientationListing(repoRoot: string): Promise<string> {
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
	const additionalContext = await orientationListing(String(repoRootPath()))

	if (!additionalContext) return

	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }))
}

try {
	await main()
} catch {
	// See the header: orientation is worth less than a session that starts.
}
