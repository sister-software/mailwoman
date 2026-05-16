/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createPathBuilderResolver, Join, PathBuilder } from "path-ts"

/**
 * Aliased path to the root of the repository.
 *
 * @typedef {"mailwoman"} RepoRootAlias
 */

/**
 * Compiled directory name for TS output files.
 */
export const OutDirectoryName = "out"
export type OutDirectoryName = typeof OutDirectoryName

const RepoRootAlias = "mailwoman" as const
type RepoRootAlias = typeof RepoRootAlias

const PathReflection = ["packages", "core", "out", "utils"] as const
type PathReflection = typeof PathReflection

/**
 * The directory path of the current file, post-compilation.
 */
const __dirname = dirname(fileURLToPath(import.meta.url)) as Join<[RepoRootAlias, ...PathReflection], "/">

/**
 * The absolute path to the root of the repository.
 */
const RepoRootAbsolutePath = resolve(__dirname, ...PathReflection.map(() => ".."))
type RepoRootAbsolutePath = RepoRootAlias

/**
 * Path builder relative to the repo root.
 */
export const repoRootPathBuilder = createPathBuilderResolver<RepoRootAlias>(RepoRootAbsolutePath)

/**
 * Path builder relative to a specific package's output directory.
 */
export function tsOutPathBuilder<S extends string[]>(
	...pathSegments: S
): PathBuilder<Join<[RepoRootAlias, OutDirectoryName, ...S], "/">> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return repoRootPathBuilder(OutDirectoryName, ...pathSegments) as any
}

export type AddressResource = "chromium-i18n/ssl-address" | "libpostal" | "internal" | "whosonfirst"

/**
 * Path builder relative to a address resource dictionary directory
 */
export function resourceDictionaryPathBuilder<A extends AddressResource, S extends string[]>(
	resource: A,
	...pathSegments: S
) {
	return repoRootPathBuilder("resources", resource, "dictionaries", ...pathSegments)
}

/**
 * Absolute path to the test directory.
 */
export const functionTestsDirectory = repoRootPathBuilder("test")
