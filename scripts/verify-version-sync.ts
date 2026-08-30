#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse to publish a tree whose workspace manifests disagree with the root about the version.
 *
 *   The publish workflow's phase 2 runs against `main` AFTER the release PR has merged. A drifted tree
 *   means phase 1 never landed, or landed partially, and publishing it ships mixed versions across a
 *   release that is supposed to move in lockstep. This ran as a heredoc inside `publish.yml` until
 *   #1894 phase 2; embedded JS in YAML is the one code in this repo that no compiler, linter or test
 *   ever reads, which is how the workflow's other hand-maintained paths went stale after the regroup.
 *
 *   Output contract: prints `RESOLVED_VERSION=<x.y.z>` on success — the same line
 *   `prepare-release-version.ts` prints and the workflow greps. A bare version on stdout would not do:
 *   `runIfScript` writes its environment banner there first.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { runIfScript } from "@mailwoman/core/scripting"
import { repoRootPath } from "@mailwoman/core/utils"
import { resolve } from "@mailwoman/platform/path"

import { releaseWorkspaces } from "./release-stage.ts"

/**
 * One workspace whose manifest version does not equal the root's.
 */
export interface VersionDrift {
	workspace: string
	version: string
}

export interface VersionSyncResult {
	/**
	 * The root manifest's version — the number every release workspace must carry.
	 */
	version: string
	drift: VersionDrift[]
	/**
	 * How many release workspaces were compared.
	 */
	compared: number
}

/**
 * Compare every `.release-it.json` workspace's version against the root's.
 */
export async function checkVersionSync(repoRoot: string): Promise<VersionSyncResult> {
	const root = await readLocalJSONFile<{ version?: unknown }>(resolve(repoRoot, "package.json"))

	if (typeof root.version !== "string") {
		throw new TypeError(`verify-version-sync: ${repoRoot}/package.json declares no string "version".`)
	}

	const workspaces = await releaseWorkspaces(repoRoot)
	const drift: VersionDrift[] = []

	for (const workspace of workspaces) {
		const manifestPath = resolve(repoRoot, workspace, "package.json")
		const manifest = await readLocalJSONFile<{ version?: unknown }>(manifestPath)

		if (manifest.version !== root.version) {
			drift.push({ workspace, version: String(manifest.version) })
		}
	}

	return { version: root.version, drift, compared: workspaces.length }
}

async function main(): Promise<void> {
	const result = await checkVersionSync(String(repoRootPath()))

	if (result.drift.length) {
		for (const { workspace, version } of result.drift) {
			process.stderr.write(`✗ ${workspace} is at ${version}, root is at ${result.version}\n`)
		}

		throw new Error(
			`verify-version-sync: ${result.drift.length} of ${result.compared} release workspaces disagree with the root ` +
				`version ${result.version} — the release PR has not fully landed, and publishing now ships mixed versions.`
		)
	}

	process.stderr.write(`main is version-synced at ${result.version} (root + ${result.compared} workspaces)\n`)
	process.stdout.write(`RESOLVED_VERSION=${result.version}\n`)
}

runIfScript(import.meta, main)
