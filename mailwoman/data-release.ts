/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Versioned data-artifact addressing + atomic switchover (#485 piece 4). Shard DBs are addressed as
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

import { existsSync, readFileSync } from "node:fs"

/** Family (shard subdir + filename prefix, e.g. `"address-points"`) → current version string. */
export type DataReleaseManifest = Record<string, string>

/** Read `<dataRoot>/releases.json`. Returns null (legacy mode) when absent or malformed. */
export function readReleaseManifest(dataRoot: string): DataReleaseManifest | null {
	try {
		const raw = JSON.parse(readFileSync(`${dataRoot}/releases.json`, "utf8")) as unknown
		if (!raw || typeof raw !== "object") return null
		const out: DataReleaseManifest = {}
		for (const [family, version] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof version === "string" && version) out[family] = version
		}
		return Object.keys(out).length > 0 ? out : null
	} catch {
		return null
	}
}

/**
 * Resolve a shard's on-disk path: the manifest-pinned `<family>-us-<slug>-<version>.db` when
 * present, else the legacy unversioned `<family>-us-<slug>.db`, else null if neither exists.
 */
export function resolveShardPath(
	dataRoot: string,
	family: string,
	slug: string,
	manifest: DataReleaseManifest | null
): string | null {
	const version = manifest?.[family]
	if (version) {
		const versioned = `${dataRoot}/${family}/${family}-us-${slug}-${version}.db`
		if (existsSync(versioned)) return versioned
	}
	const legacy = `${dataRoot}/${family}/${family}-us-${slug}.db`
	return existsSync(legacy) ? legacy : null
}
