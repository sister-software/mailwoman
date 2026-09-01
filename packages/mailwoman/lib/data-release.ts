/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Versioned data-artifact addressing + atomic switchover (#485 piece 4). Database DBs are addressed as
 *   `<family>/<family>-us-<slug>-<version>.db`, with a `releases.json` manifest at the data root
 *   pinning each family to its current version. So a new build publishes ALONGSIDE the old,
 *   flipping the manifest (one atomic file write) cuts traffic over, and the build provenance (the
 *   version) travels in the filename — "what data is deployed" is a read of one JSON.
 *
 *   Back-compat: with no manifest (or a family unlisted) resolution falls back to the legacy
 *   unversioned `<family>-us-<slug>.db`, so the current national build output works unchanged.
 *
 *   Example `releases.json`: { "address-points": "2026-05-20.0", "interpolation": "TIGER2023" }
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { join } from "path-ts"

import type { BundleArtifact } from "#data-bundles"

/**
 * Family (database subdir + filename prefix, e.g. `"address-points"`) → current version string.
 */
export type DataReleaseManifest = Record<string, string>

/**
 * Read `<dataRoot>/releases.json`. Returns null (legacy mode) when absent or malformed.
 */
export async function readReleaseManifest(dataRoot: string): Promise<DataReleaseManifest | null> {
	try {
		const raw = tryParsingJSON(await readLocalTextFile(join(dataRoot, "releases.json")))

		if (!raw || typeof raw !== "object") return null
		const out: DataReleaseManifest = {}

		for (const [family, version] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof version === "string" && version) {
				out[family] = version
			}
		}

		return Object.keys(out).length ? out : null
	} catch {
		return null
	}
}

/**
 * Resolve a database's on-disk path: the manifest-pinned `<family>-us-<slug>-<version>.db` when present, else the
 * legacy unversioned `<family>-us-<slug>.db`, else null if neither exists.
 */
export async function resolveDatabasePath(
	dataRoot: string,
	family: string,
	slug: string,
	manifest: DataReleaseManifest | null
): Promise<string | null> {
	const version = manifest?.[family]

	if (version) {
		const versioned = join(dataRoot, family, `${family}-us-${slug}-${version}.db`)

		if (await pathExists(versioned)) return versioned
	}

	const legacy = join(dataRoot, family, `${family}-us-${slug}.db`)

	return (await pathExists(legacy)) ? legacy : null
}

/**
 * The path a `us`-family artifact ALREADY occupies on disk (versioned or legacy, via {@link resolveDatabasePath}), or
 * the artifact's own resolved path for a non-family artifact — `null` when nothing is there yet. Shared by `data pull`
 * and `data status`, so "already present" means the same thing to both.
 */
export async function existingLocalPath(
	dataRoot: string,
	manifest: DataReleaseManifest | null,
	artifact: BundleArtifact,
	resolvedAbsPath: string
): Promise<string | null> {
	if (artifact.family && artifact.stateSlug) {
		return await resolveDatabasePath(dataRoot, artifact.family, artifact.stateSlug, manifest)
	}

	return (await pathExists(resolvedAbsPath)) ? resolvedAbsPath : null
}
