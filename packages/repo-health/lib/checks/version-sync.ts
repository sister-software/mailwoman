/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse to publish a tree whose workspace manifests disagree with the root about the version.
 *
 *   The publish workflow's phase 2 runs against `main` AFTER the release PR has merged. A drifted tree means phase 1
 *   never landed, or landed partially, and publishing it ships mixed versions across a release that is supposed to move
 *   in lockstep. The workflow runs this check and then reads the root manifest's version itself: a check reports
 *   diagnostics, and a passing one has established that the root's number is every release workspace's number.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * The publish set: `.release-it.json`'s `@release-it-plugins/workspaces` list, which is also the bump set. The release
 * tooling reads the same list through its own copy of this reader; when `@mailwoman/release-kit` exports one, this
 * check imports it and the copy goes.
 */
async function releaseWorkspaces(repoRoot: string): Promise<string[]> {
	const config = await readLocalJSONFile<{
		plugins?: { "@release-it-plugins/workspaces"?: { workspaces?: unknown } }
	}>(resolvePath(repoRoot, ".release-it.json"))

	const workspaces = config.plugins?.["@release-it-plugins/workspaces"]?.workspaces

	if (!Array.isArray(workspaces) || !workspaces.length) {
		throw new Error("could not read a non-empty workspaces array from .release-it.json")
	}

	const list = workspaces.filter((entry): entry is string => typeof entry === "string")

	if (list.length !== workspaces.length) {
		throw new Error(".release-it.json workspaces array carries a non-string entry")
	}

	return list
}

/**
 * The `version-sync` check: one error per release workspace whose manifest version differs from the root's.
 */
export const versionSyncCheck: RepoCheck = {
	id: "version-sync",
	description: "Every release workspace's manifest version equals the root's.",
	async run(context) {
		const root = await readLocalJSONFile<{ version?: unknown }>(resolvePath(context.repoRoot, "package.json"))

		if (typeof root.version !== "string") {
			throw new TypeError(`version-sync: ${context.repoRoot}/package.json declares no string "version".`)
		}

		const workspaces = await releaseWorkspaces(context.repoRoot)
		const diagnostics: Diagnostic[] = []

		for (const workspace of workspaces) {
			const file = `${workspace}/package.json`
			const manifest = await readLocalJSONFile<{ version?: unknown }>(resolvePath(context.repoRoot, file))

			if (manifest.version !== root.version) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${workspace} is at ${String(manifest.version)}, root is at ${root.version} — the release PR has not fully landed, and publishing now ships mixed versions`,
					file,
				})
			}
		}

		return diagnostics
	},
}
