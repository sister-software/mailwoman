/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Versioned data-artifact addressing + atomic switchover (#485 piece 4). Database DBs are addressed as
 *   `db/<family>/<family>-us-<slug>-<version>.db`, with a `releases.json` manifest at the data root
 *   pinning each family to its current version. So a new build publishes alongside the old,
 *   flipping the manifest (one atomic file write) switches traffic over, and the build provenance (the
 *   version) travels in the filename — "what data is deployed" is a read of one JSON.
 *
 *   Back-compat: with no manifest (or a family unlisted) resolution falls back to the legacy
 *   unversioned `<family>-us-<slug>.db`, so the current national build output works unchanged.
 *
 *   Example `releases.json`: { "address-points": "2026-05-20.0", "interpolation": "TIGER2023" }
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/json"
import { addressPointDatabaseRoot, interpolationDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PathBuilder, PathBuilderLike } from "path-ts"

import type { BundleArtifact } from "#data/bundles"

/**
 * Family (database subdir + filename prefix, e.g. `"address-points"`) → current version string.
 */
export type DataReleaseManifest = Record<string, string>

/**
 * Read `<dataRoot>/releases.json`.
 *
 * @returns Null (legacy mode) when absent or malformed.
 */
export async function readReleaseManifest(dataRoot: PathBuilderLike): Promise<DataReleaseManifest | null> {
	try {
		const raw = tryParsingJSON(await readLocalTextFile(dataRoot, "releases.json"))

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
 * A database family the release manifest pins.
 */
export type DatabaseFamily = NonNullable<BundleArtifact["family"]>

/**
 * The directory each family's databases live in, from the package that owns the family.
 */
const FAMILY_DIRECTORIES = {
	"address-points": addressPointDatabaseRoot,
	interpolation: interpolationDatabaseRoot,
} as const satisfies Record<DatabaseFamily, (dataRoot: PathBuilderLike) => PathBuilder>

/**
 * Resolve a database's on-disk path: the manifest-pinned `<family>-us-<slug>-<version>.db`
 * when present, else the legacy unversioned `<family>-us-<slug>.db`, else null if neither exists.
 */
export async function resolveDatabasePath(
	dataRoot: PathBuilderLike,
	family: DatabaseFamily,
	slug: string,
	manifest: DataReleaseManifest | null
): Promise<string | null> {
	const directory = FAMILY_DIRECTORIES[family](dataRoot)
	const version = manifest?.[family]

	if (version) {
		const versioned = directory(`${family}-us-${slug}-${version}.db`)

		if (await pathExists(versioned)) return versioned.toString()
	}

	const legacy = directory(`${family}-us-${slug}.db`)

	return (await pathExists(legacy)) ? legacy.toString() : null
}

/**
 * The path a `us`-family artifact already occupies on disk (versioned or legacy, via
 * {@link resolveDatabasePath}), or the artifact's own resolved path for a non-family artifact.
 * `null` when nothing is there yet.
 *
 * Shared by `data pull` and `data status`, so "already present" means the same thing to both.
 */
export async function existingLocalPath(
	dataRoot: PathBuilderLike,
	manifest: DataReleaseManifest | null,
	artifact: BundleArtifact,
	resolvedAbsPath: string
): Promise<string | null> {
	if (artifact.family && artifact.stateSlug) {
		return await resolveDatabasePath(dataRoot, artifact.family, artifact.stateSlug, manifest)
	}

	return (await pathExists(resolvedAbsPath)) ? resolvedAbsPath : null
}
