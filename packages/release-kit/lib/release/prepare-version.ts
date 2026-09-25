/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { resolvePath } from "path-ts"
import semver from "semver"

import { bumpReleaseConfigVersion } from "#release/config-version"
import { releaseWorkspaces } from "#release/stage"

/**
 * Options for {@link prepareReleaseVersion}; `version` is `patch`, `minor`, `major`
 * or an explicit semver, and `checkOnly` validates without writing.
 */
export interface PrepareReleaseVersionOptions {
	repoRoot: string
	version: string
	checkOnly: boolean
	log: (line: string) => void
}

/**
 * The version before and after a {@link prepareReleaseVersion} run, and how many
 * files it wrote (zero in check-only mode).
 */
export interface PrepareReleaseVersionReport {
	currentVersion: string
	resolvedVersion: string

	/**
	 * The number of versioned files written, counting the root, each release workspace
	 * and `release.config.json`; zero under `checkOnly`.
	 */
	filesWritten: number
}

function fail(message: string): never {
	throw new Error(`prepare-release-version: ${message}`)
}

/**
 * Bumps the root manifest, every release workspace manifest and `release.config.json` to one target version.
 *
 * @throws When the target is not greater than the current version, or when any of
 * those files already disagree on the current version.
 */
export async function prepareReleaseVersion(
	options: PrepareReleaseVersionOptions
): Promise<PrepareReleaseVersionReport> {
	const { repoRoot, log } = options

	if (!options.version) {
		fail("--version is required (patch | minor | major | x.y.z)")
	}

	const rootManifestPath = resolvePath(repoRoot, "package.json")
	const rootManifest = await readPackageJSON(rootManifestPath)

	if (typeof rootManifest.version !== "string" || !semver.valid(rootManifest.version)) {
		fail(`root package.json version is not a valid semver: ${rootManifest.version}`)
	}

	let targetVersion: string

	if (options.version === "major" || options.version === "minor" || options.version === "patch") {
		targetVersion =
			semver.inc(rootManifest.version, options.version) ?? fail(`semver.inc failed on ${rootManifest.version}`)
	} else {
		const explicit = semver.valid(options.version)

		if (!explicit) {
			fail(`not a valid semver or increment keyword: "${options.version}"`)
		}

		if (!semver.gt(explicit, rootManifest.version)) {
			fail(`explicit target ${explicit} is not greater than the current root version ${rootManifest.version}`)
		}

		targetVersion = explicit
	}

	const workspaces = await releaseWorkspaces(repoRoot)

	const manifestPaths = [rootManifestPath, ...workspaces.map((ws) => resolvePath(repoRoot, ws, "package.json"))]

	const parsed: Array<{ path: string; manifest: Record<string, unknown> }> = []

	for (const path of manifestPaths) {
		const manifest = await readPackageJSON(path)

		if (typeof manifest.version !== "string") {
			fail(`${path} has no version field`)
		}

		parsed.push({ path, manifest })
	}

	for (const { path, manifest } of parsed) {
		if (manifest.version !== rootManifest.version) {
			fail(
				`${path} is at ${String(manifest.version)} but the root is at ${rootManifest.version} — ` +
					`the tree is not version-synced; refusing to bump on top of drift`
			)
		}
	}

	const releaseConfigPath = resolvePath(repoRoot, "release.config.json")
	const releaseConfigText = await readLocalTextFile(releaseConfigPath)
	const releaseConfig = parseJSONStrict<{ version?: string }>(releaseConfigText)

	if (releaseConfig.version !== rootManifest.version) {
		fail(
			`release.config.json is at ${releaseConfig.version} but the root is at ${rootManifest.version} — ` +
				`the tree is not version-synced; refusing to bump on top of drift`
		)
	}

	let filesWritten = 0

	if (!options.checkOnly) {
		for (const { path, manifest } of parsed) {
			manifest.version = targetVersion
			await writeLocalJSONFile(manifest, path)
		}

		await writeLocalTextFile(
			bumpReleaseConfigVersion(releaseConfigText, rootManifest.version, targetVersion),
			releaseConfigPath
		)

		filesWritten = parsed.length + 1

		log(
			`bumped ${filesWritten} versioned files (root + ${workspaces.length} workspaces + release.config.json) to ${targetVersion}`
		)
	}

	return { currentVersion: rootManifest.version, resolvedVersion: targetVersion, filesWritten }
}
