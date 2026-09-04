/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-1 of the PR-based release flow: write the target version into the root `package.json` +
 *   every workspace listed in `.release-it.json` — and do NOTHING else. No git, no tags, no npm. The
 *   caller (`publish.yml`'s `prepare` job) commits the result onto a `release/v<version>` branch and
 *   opens the release PR; the tag + npm publish happen in the separate `publish` phase only after
 *   that PR has merged through the "Production Integrity" ruleset (PR + green `test` required on
 *   `main` — the ruleset that rejects release-it's direct push).
 *
 *   The workspace list is read from `.release-it.json` — the SAME list the per-workspace publish
 *   loop derives (#756: one source of truth, so this operation can't drift from what actually
 *   publishes). Semver parsing/increment is the `semver` package.
 *
 *   Output contract: the operation answers `resolvedVersion`, and the CLI adapter prints
 *   `RESOLVED_VERSION=<x.y.z>` — the workflow greps this line (no $GITHUB_OUTPUT / env access here).
 *
 *   Inputs:
 *
 *   - `version` (required) — `patch|minor|major` (increment from the root version) or an explicit
 *       target, which must be strictly greater than the current root version.
 *   - `checkOnly` — resolve + validate + report, but write nothing (the dry-run path).
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { resolvePath } from "path-ts"
import semver from "semver"

import { bumpReleaseConfigVersion } from "#release/config-version"
import { releaseWorkspaces } from "#release/stage"

export interface PrepareReleaseVersionOptions {
	repoRoot: string
	version: string
	checkOnly: boolean
	log: (line: string) => void
}

export interface PrepareReleaseVersionReport {
	currentVersion: string
	resolvedVersion: string
	/**
	 * Version-bearing files written: root + every release workspace + `release.config.json`. Zero under `checkOnly`.
	 */
	filesWritten: number
}

function fail(message: string): never {
	throw new Error(`prepare-release-version: ${message}`)
}

export async function prepareReleaseVersion(
	options: PrepareReleaseVersionOptions
): Promise<PrepareReleaseVersionReport> {
	const { repoRoot, log } = options

	if (!options.version) {
		fail("--version is required (patch | minor | major | x.y.z)")
	}

	const rootManifestPath = resolvePath(repoRoot, "package.json")
	const rootManifest = await readLocalJSONFile<{ version?: string }>(rootManifestPath)

	if (typeof rootManifest.version !== "string" || !semver.valid(rootManifest.version)) {
		fail(`root package.json version is not a valid semver: ${String(rootManifest.version)}`)
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

	// The SAME workspace list the publish loop uses (#756) — root + these is the full bump surface.
	// The canonical reader (stage.ts) refuses an empty or malformed list.
	const workspaces = await releaseWorkspaces(repoRoot)

	const manifestPaths = [rootManifestPath, ...workspaces.map((ws) => resolvePath(repoRoot, ws, "package.json"))]

	// Validate the whole set BEFORE writing anything — a half-bumped tree is worse than a failed run.
	const parsed: Array<{ path: string; manifest: Record<string, unknown> }> = []

	for (const path of manifestPaths) {
		const manifest = await readLocalJSONFile<Record<string, unknown>>(path)

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

	// `release.config.json#version` carries the SAME unified release number (RELEASING.md, its own $comment) and
	// lagged two releases running (#1024, then v9.2.0 shipping while it read 9.1.0) because nothing bumped it. It is
	// validated with the sync set but written by a one-line textual replacement — the file is oxfmt-formatted, and
	// the stringify write path used for the manifests would reformat it wholesale, moving the `weights` block a
	// code-only release must never touch (release-config-bump.test.ts pins the exact-one-line contract).
	const releaseConfigPath = resolvePath(repoRoot, "release.config.json")
	const releaseConfigText = await readLocalTextFile(releaseConfigPath)
	const releaseConfig = parseJSONStrict<{ version?: string }>(releaseConfigText)

	if (releaseConfig.version !== rootManifest.version) {
		fail(
			`release.config.json is at ${String(releaseConfig.version)} but the root is at ${rootManifest.version} — ` +
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
			`bumped ${filesWritten} version-bearing files (root + ${workspaces.length} workspaces + release.config.json) to ${targetVersion}`
		)
	}

	return { currentVersion: rootManifest.version, resolvedVersion: targetVersion, filesWritten }
}
