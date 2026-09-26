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
 * Build a path under the data root, e.g. `dataRootPath("geonames", "US.txt")`;
 * the env is read on each call, so a late environment change or a test stub is honored
 * rather than frozen at the first importer's environment.
 */
export const dataRootPath = createPathBuilderResolver<"~env/data-root">(() => $public.MAILWOMAN_DATA_ROOT)

/**
 * A path under the data root's database group, `$MAILWOMAN_DATA_ROOT/db/`, where every built
 * or published SQLite artifact lives one subdirectory per layer; source downloads, corpora,
 * weights and caches stay at the data root's top level and do not pass through here.
 *
 * The group name is a bare string in every path a caller composes, so the compiler reports no error
 * when a call site keeps a pre-grouping prefix: such a call site resolves to a directory that
 * does not exist, and every reader of a layer database treats an absent file as an absent layer.
 * Compose a database path through this function — via the owning package's `paths` export, for example
 * `wofDatabasePath` from `@mailwoman/resolver-wof-sqlite/paths` — so one edit moves all of them.
 */
export function databaseRootPath<T extends PathBuilderLike>(source: T) {
	return PathBuilder.from(source)("db")
}

/**
 * Path builder for the Who's On First git checkouts: `$MAILWOMAN_DATA_ROOT/src/wof-repos/`,
 * cloned sources rather than built artifacts, which `mailwoman gazetteer repos-sync` writes
 * and the admin, postcode and polygon builds read.
 */
export const wofReposPath = dataRootPath("src", "wof-repos")

/**
 * The dev-weights overlay for a locale: `$MAILWOMAN_DATA_ROOT/weights/<locale>/`,
 * kept centralized because multiple `link-dev-weights.ts` scripts write here
 * and `@mailwoman/neural` (`resolveWeights`) reads here.
 *
 * It lives outside git on purpose: weight binaries are not committed, and the data
 * root is shared across local checkouts and is never packaged.
 */
export function weightsOverlayPath(locale: string, ...segments: string[]) {
	return dataRootPath("weights", locale.toLowerCase(), ...segments)
}

/**
 * Path builder under Mailwoman's temporary-file root, e.g. `tempRootPathBuilder("reg", "fr-communes.tsv")`;
 * the env is read on each call, so a late environment change or a test stub is honored.
 */
export const tempRootPathBuilder = createPathBuilderResolver<"~env/temp-root">(() => $public.MAILWOMAN_TEMP_ROOT)

/**
 * The Mailwoman temporary-file root.
 */
export function mailwomanTempRoot(): PathBuilder {
	return tempRootPathBuilder()
}

/**
 * Absolute-path-string resolver under the temporary-file root — the string-returning sibling of
 * {@link tempRootPathBuilder}, for handing paths straight to `node:fs` and other string APIs.
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
