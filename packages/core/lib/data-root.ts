/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Path builders for Mailwoman's platform-native application directories.
 */

import { PathBuilder, type PathBuilderLike, createPathBuilderResolver, resolvePath } from "path-ts"

import { $public } from "#env/index"

/**
 * The per-user configuration root (`$MAILWOMAN_CONFIG_ROOT`, defaulting to the platform config directory):
 * where the license signing key lives, and anything else that is the operator's rather than the data's.
 */
export const configRootPath = createPathBuilderResolver<"~env/config-root">(() => $public.MAILWOMAN_CONFIG_ROOT)

/**
 * Build a path under the data root, e.g. `dataRootPath("geonames", "US.txt")`.
 *
 * Reads the env on each call, so a late environment change (or a test stub) is honored.
 * A resolver bound once at module evaluation would freeze the root to whatever
 * the first importer's environment held.
 *
 */
export const dataRootPath = createPathBuilderResolver<"~env/data-root">(() => $public.MAILWOMAN_DATA_ROOT)

/**
 * A path under the data root's database group, `$MAILWOMAN_DATA_ROOT/db/`.
 *
 * Every built or published SQLite artifact lives under this directory, one subdirectory per
 * layer: `db/wof`, `db/poi`, `db/address-points`, `db/interpolation`, `db/ban`, `db/flood`,
 * `db/soil`, `db/coastal`, `db/zoning`, `db/nsul`, `db/osm`, `db/timezone`, `db/uprn`.
 * Source downloads, corpora, weights, evaluation receipts and caches stay at the
 * data root's top level and do not pass through here.
 *
 * The group name is a bare string in every path a caller composes, so the compiler
 * reports nothing when a call site keeps a pre-grouping prefix.
 * Such a call site resolves to a directory that does not exist, and every reader of
 * a layer database treats an absent file as an absent layer.
 *
 * Compose a database path through this function so one edit moves all of them.
 * The package that owns a layer exports its directory from its `paths` subpath,
 * for example `wofDatabasePath` from `@mailwoman/resolver-wof-sqlite/paths`.
 */
export function databaseRootPath<T extends PathBuilderLike>(source: T) {
	return PathBuilder.from(source)("db")
}

/**
 * Path builder for the Who's On First git checkouts: `$MAILWOMAN_DATA_ROOT/src/wof-repos/`.
 *
 * These are cloned sources rather than built artifacts, so they sit under `src/`
 * rather than under the `db/` group {@link databaseRootPath} names.
 * `mailwoman gazetteer repos-sync` writes them and the admin, postcode and polygon builds read them.
 */
export const wofReposPath = dataRootPath("src", "wof-repos")

/**
 * The dev-weights overlay for a locale: `$MAILWOMAN_DATA_ROOT/weights/<locale>/`.
 *
 * Keep this location centralized: multiple `link-dev-weights.ts` scripts write here,
 * and `@mailwoman/neural` (`resolveWeights`) reads from here.
 *
 * This lives outside git on purpose.
 * Weight binaries are not committed, and writing them into tracked package directories
 * caused worktree churn and publish issues (`YN0035`).
 *
 * The data root is shared across local checkouts and is never packaged.
 */
export function weightsOverlayPath(locale: string, ...segments: string[]) {
	return dataRootPath("weights", locale.toLowerCase(), ...segments)
}

/**
 * Path builder under Mailwoman's temporary-file root, e.g. `tempRootPathBuilder("reg", "fr-communes.tsv")`.
 *
 * Reads the env on each call, so a late environment change (or a test stub) is honored.
 */
export const tempRootPathBuilder = createPathBuilderResolver<"~env/temp-root">(() => $public.MAILWOMAN_TEMP_ROOT)

/**
 * The Mailwoman temporary-file root.
 */
export function mailwomanTempRoot(): PathBuilder {
	return tempRootPathBuilder()
}

/**
 * Absolute-path-string resolver under the temporary-file root — the string-returning
 * sibling of {@link tempRootPathBuilder}, for handing paths straight to `node:fs`
 * and other string APIs without a `.toString()`.
 */
export function tempRootPath(...segments: string[]): string {
	return resolvePath($public.MAILWOMAN_TEMP_ROOT, ...segments)
}

/**
 * The Mailwoman cache root from the typed public environment.
 */
export const cacheRootPathBuilder = createPathBuilderResolver<"~env/cache-root">(() => $public.MAILWOMAN_CACHE_ROOT)

/**
 * The Mailwoman cache root.
 */
export function mailwomanCacheRoot(): PathBuilder {
	return cacheRootPathBuilder()
}

/**
 * Absolute path string under the Mailwoman cache root.
 */
export function cacheRootPath(...segments: string[]): string {
	return cacheRootPathBuilder(...segments).toString()
}
