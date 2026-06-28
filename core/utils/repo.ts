/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createPathBuilderResolver, type Join, type PathBuilder } from "path-ts"

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

const PathReflection = ["core", "out", "utils"] as const
type PathReflection = typeof PathReflection

/**
 * The directory path of the current file, post-compilation.
 */
const __dirname = dirname(fileURLToPath(import.meta.url)) as Join<[RepoRootAlias, ...PathReflection], "/">

/**
 * The absolute path to the root of the repository.
 *
 * In compiled mode this file lives at `core/out/utils/repo.js` (so the PARENT of `utils` is `out/`) and in source mode
 * at `core/utils/repo.ts` (the parent is `core/`). Detect the mode by checking whether the parent directory
 * (`resolve("..")`) is `out/` — uses `basename` on the resolved path rather than a substring match on `__dirname`, so
 * it survives symlinks and output-directory renames.
 *
 * (Earlier this checked `resolve("..", "..")`, which overshoots `out/` to `core/` and so was always false — the
 * compiled tree then resolved `CorePackageAbsolutePath` to `core/out` instead of `core/`, landing dictionary reads at
 * the nonexistent `core/out/data` and requiring an external symlink bridge to find `core/data`. #481.)
 */
const __isCompiledTree = basename(resolve(__dirname, "..")) === OutDirectoryName
const __upCount = __isCompiledTree ? PathReflection.length : PathReflection.length - 1
const RepoRootAbsolutePath = resolve(__dirname, ...Array.from({ length: __upCount }, () => ".."))
type RepoRootAbsolutePath = RepoRootAlias

/**
 * Path builder relative to the repo root.
 */
export const repoRootPathBuilder = createPathBuilderResolver<RepoRootAlias>(RepoRootAbsolutePath)

/**
 * Path builder relative to the `@mailwoman/core` workspace root (the directory containing `package.json` for this
 * package).
 *
 * In compiled mode this resolves to `core/` (one level above `core/out/utils/repo.js`'s `out/`). In source mode it's
 * the same `core/` directly above `core/utils/repo.ts`. Used to locate package-bundled assets (dictionary data) that
 * live under the workspace root, NOT the repo root — so that `npm install @mailwoman/core` ships those assets alongside
 * the JS without any post-install copy step.
 */
const CorePackageAbsolutePath = resolve(__dirname, "..", __isCompiledTree ? ".." : "")
export const corePackagePathBuilder = createPathBuilderResolver<RepoRootAlias>(CorePackageAbsolutePath)

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
 * Path builder relative to a address resource dictionary directory.
 *
 * Data lives at `core/data/<resource>/dictionaries/...` so the @mailwoman/core npm package ships dictionaries via its
 * `files` glob. Use {@link corePackagePathBuilder} directly for non- dictionary assets (e.g. chromium-i18n/ssl-address)
 * that don't have the `dictionaries/` subdir.
 */
export function resourceDictionaryPathBuilder<A extends AddressResource, S extends string[]>(
	resource: A,
	...pathSegments: S
) {
	return corePackagePathBuilder("data", resource, "dictionaries", ...pathSegments)
}

/**
 * Absolute path to the test directory.
 */
export const functionTestsDirectory = repoRootPathBuilder("test")
