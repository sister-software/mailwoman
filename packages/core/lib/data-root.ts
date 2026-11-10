/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Path builders for Mailwoman's platform-native application directories.
 */

import { PathBuilder, type PathBuilderLike, createPathBuilderResolver, resolvePath } from "path-ts"

import { $public } from "#env"

/**
 * The per-user configuration root is `$MAILWOMAN_CONFIG_ROOT`.
 *
 * It defaults to the platform config directory and stores the license signing
 * key plus other operator-owned files.
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
 * or published SQLite artifact lives one subdirectory per layer.
 *
 * Source downloads, corpora, weights and caches stay at the data root's top level
 * and do not pass through here.
 *
 * The group name is a bare string in every path a caller composes,
 * so the compiler reports no error when a call site keeps a pre-grouping prefix:
 * such a call site resolves to a directory that doesn't exist.
 * Every reader of a layer database treats an absent file as an absent layer.
 *
 * Compose a database path through this function — via the owning package's `paths` export, for example
 * `wofDatabasePath` from `@mailwoman/resolver-wof-sqlite/paths` — so one edit moves all of them.
 */
export function databaseRootPath<T extends PathBuilderLike>(source: T) {
	return PathBuilder.from(source)("db")
}

/**
 * Path builder for the Who's On First git checkouts: `$MAILWOMAN_DATA_ROOT/src/wof-repos/<name>`.
 * They're cloned sources rather than built artifacts.
 *
 * `mailwoman gazetteer inspect sync` clones each repository here from its `mailwoman` fork.
 * Admin builds read here.
 * Postcode builds and polygon builds also read from here.
 */
export const wofReposPath = dataRootPath("src", "wof-repos")

/**
 * A vintage names one dated pull of a source: a year, month or day (`2026`, `2026-08`, `2026-08-31`),
 * or the publisher's release id (`2026-05-20.0`, `r24`, `fy23`).
 * It is one path segment.
 */
const VINTAGE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/**
 * Throws unless `vintage` is one path segment a vintage can take.
 */
export function assertVintage(vintage: string): void {
	if (!VINTAGE.test(vintage) || vintage.includes("..")) {
		throw new Error(`"${vintage}" is not a vintage: use a date such as 2026-08-31 or a release id such as r24`)
	}
}

/**
 * A path under a current source's download directory, `$MAILWOMAN_CACHE_ROOT/sources/<source>/`.
 *
 * A current source is mutable, and fetching it again brings it up to date: a git clone,
 * or a download the publisher serves under an undated name.
 * A customer who clears the cache root fetches the source again and loses no data.
 */
export function currentSourcePath(source: string, ...segments: string[]): PathBuilder {
	return cacheRootPathBuilder("sources", source, ...segments)
}

/**
 * A path under one vintage of a snapshot source, `$MAILWOMAN_DATA_ROOT/snapshots/<source>/<vintage>/`.
 *
 * A snapshot is a dated pull that is read-only once written.
 * A newer vintage sits beside it and supersedes it.
 *
 * Write one through `writeSnapshot` from `@mailwoman/core/fs/snapshot`.
 *
 * @throws When `vintage` is not one path segment a vintage can take.
 */
export function snapshotSourcePath(source: string, vintage: string, ...segments: string[]): PathBuilder {
	assertVintage(vintage)

	return dataRootPath("snapshots", source, vintage, ...segments)
}

/**
 * The dev-weights overlay for a locale is `$MAILWOMAN_DATA_ROOT/weights/<locale>/`.
 *
 * Multiple `link-dev-weights.ts` scripts write here.
 * `@mailwoman/neural` (`resolveWeights`) reads from this directory.
 *
 * It lives outside git because the data root is shared across local checkouts and never packaged.
 * Weight binaries stay outside the repository.
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
