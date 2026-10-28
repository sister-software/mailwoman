/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Databases are addressed as `db/<family>/<family>-us-<slug>-<version>.db`, with a `releases.json`
 *   manifest at the data root pinning each family to its current version, so a new build publishes
 *   alongside the old and flipping the manifest (one atomic file write) switches traffic over with the
 *   version travelling in the filename.
 *
 *   With no manifest, or a family unlisted, resolution falls back to the legacy unversioned
 *   `<family>-us-<slug>.db`, so the current national build output works unchanged.
 *
 *   Example `releases.json`: { "address-points": "2026-05-20.0", "interpolation": "TIGER2023" }
 */

import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { JSONParseError, stringifyJSON } from "@mailwoman/core/json"
import { UnreadableArtifactError, UnreadableReason } from "@mailwoman/core/layers"
import { addressPointDatabaseRoot, interpolationDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { resolvePathBuilder, type PathBuilder, type PathBuilderLike } from "path-ts"

import type { BundleArtifact } from "#data/bundles"

/**
 * Family (database subdir + filename prefix, e.g. `"address-points"`) → current version string.
 */
export type DataReleaseManifest = Record<string, string>

/**
 * Read `<dataRoot>/releases.json`.
 *
 * A manifest that exists and cannot be read, parsed, or interpreted is an error naming its path.
 * Legacy mode in its place would serve the unversioned databases while the
 * operator believes a pin is in force.
 *
 * @returns Null (legacy mode) when the file is absent or pins no family.
 * @throws {@link UnreadableArtifactError} when the file exists and cannot be read,
 * or holds anything but an object of family names to non-empty version strings.
 */
export async function readReleaseManifest(dataRoot: PathBuilderLike): Promise<DataReleaseManifest | null> {
	const path = resolvePathBuilder(dataRoot, "releases.json").toString()
	let raw: unknown

	try {
		raw = await tryReadLocalJSONFile<unknown>(path)
	} catch (error) {
		const reason = error instanceof JSONParseError ? UnreadableReason.Corrupt : UnreadableReason.Unopenable

		throw new UnreadableArtifactError(path, reason, (error as Error).message, { cause: error })
	}

	if (raw == null) return null

	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new UnreadableArtifactError(path, UnreadableReason.Corrupt, "expected an object of family to version")
	}

	const out: DataReleaseManifest = {}

	for (const [family, version] of Object.entries(raw)) {
		if (typeof version !== "string" || !version) {
			throw new UnreadableArtifactError(
				path,
				UnreadableReason.Corrupt,
				`family ${family} pins ${stringifyJSON(version)}, not a version string`
			)
		}

		out[family] = version
	}

	return Object.keys(out).length ? out : null
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
 * The path a `us`-family artifact already occupies on disk (versioned or legacy), or the
 * artifact's own resolved path for a non-family artifact, or `null` when no artifact is there yet.
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
		return resolveDatabasePath(dataRoot, artifact.family, artifact.stateSlug, manifest)
	}

	return (await pathExists(resolvedAbsPath)) ? resolvedAbsPath : null
}
