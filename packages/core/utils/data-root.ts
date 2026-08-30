/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Path builders for Mailwoman's platform-native application directories.
 */

import { resolvePath, resolvePathBuilder, type PathBuilder } from "path-ts"

import { $public } from "../env/index.ts"

/**
 * The Mailwoman data root from the typed public environment.
 */
export function mailwomanDataRoot(): string {
	return $public.MAILWOMAN_DATA_ROOT
}

/**
 * Build an absolute path under the data root, e.g. `dataRootPath("wof", "admin-global-priority.db")`. Reads the env on
 * each call, so a late environment change (or a test stub) is honored.
 */
export function dataRootPath(...segments: string[]): string {
	return resolvePath(mailwomanDataRoot(), ...segments)
}

/**
 * The dev-weights overlay for a locale: `$MAILWOMAN_DATA_ROOT/weights/<locale>/`.
 *
 * ONE definition of the convention, because it is written by ten `link-dev-weights.ts` scripts and read by
 * `@mailwoman/neural`'s `resolveWeights`, and a reader that disagreed with the writers about the directory would report
 * the artifacts absent rather than misplaced — every sibling degrades `existsSync → undefined`.
 *
 * It lives OUTSIDE git deliberately. The binaries are not committed, so materializing them into the tracked package
 * directory is what made a fresh worktree unable to geocode, made `yarn test` mutate tracked directories as a side
 * effect, and put a symlink in a publish tarball (`YN0035`). The data root is shared across every checkout on the
 * machine and is not packed by anything.
 */
export function weightsOverlayPath(locale: string, ...segments: string[]): string {
	return dataRootPath("weights", locale.toLowerCase(), ...segments)
}

/**
 * The Mailwoman temporary-file root from the typed public environment.
 */
export function mailwomanTempRoot(): PathBuilder {
	return resolvePathBuilder($public.MAILWOMAN_TEMP_ROOT)
}

/**
 * Path builder under Mailwoman's temporary-file root, e.g. `tempRootPathBuilder("reg", "fr-communes.tsv")`. Reads the
 * env on each call, so a late environment change (or a test stub) is honored.
 */
export function tempRootPathBuilder(...segments: string[]): PathBuilder {
	return resolvePathBuilder($public.MAILWOMAN_TEMP_ROOT, ...segments)
}

/**
 * Absolute-path-string resolver under the temporary-file root — the string-returning sibling of
 * {@link tempRootPathBuilder}, for handing paths straight to `node:fs` and other string APIs without a `.toString()`.
 */
export function tempRootPath(...segments: string[]): string {
	return resolvePath($public.MAILWOMAN_TEMP_ROOT, ...segments)
}

/**
 * The Mailwoman cache root from the typed public environment.
 */
export function mailwomanCacheRoot(): PathBuilder {
	return resolvePathBuilder($public.MAILWOMAN_CACHE_ROOT)
}

/**
 * Path builder under Mailwoman's application cache directory.
 */
export function cacheRootPathBuilder(...segments: string[]): PathBuilder {
	return resolvePathBuilder($public.MAILWOMAN_CACHE_ROOT, ...segments)
}

/**
 * Absolute-path-string resolver under the cache directory — the string-returning sibling of
 * {@link cacheRootPathBuilder}.
 */
export function cacheRootPath(...segments: string[]): string {
	return resolvePath($public.MAILWOMAN_CACHE_ROOT, ...segments)
}

/**
 * The default WOF shard list the FTS backend probes when no single `--wof-db` is given: the global admin-priority shard
 * plus the postcode shards, with country-aware routing in `pickShardForPlacetype` sending each postcode query to the
 * shard that claims its country (#920). All under `dataRoot` (defaults to the configured {@link mailwomanDataRoot};
 * callers thread a `--data-root` option through). A fresh array each call; callers filter with `existsSync`, so a
 * deployment missing any of them degrades to whatever is present.
 *
 * This list is DELIBERATELY SMALLER than `DEFAULT_POSTCODE_SHARDS` (`mailwoman/gazetteer-pipeline/index.ts`), which is
 * the set the candidate gazetteer is BUILT from — twenty-odd shards including the 876 MB Code-Point Open GB one. These
 * are attached live per query, so the cost of a member is paid at every boot rather than once at build time; membership
 * here is earned by a shard the runtime cannot resolve its locales without.
 *
 * Two notes on specific members, because both look like mistakes and are not:
 *
 * - The tail shard's own contents moved on 2026-08-05. It carried GB (1,839,678 of 1,895,753 rows, ~946 MB) until
 *   Code-Point Open replaced those rows under a clean licence; it is now the nine-country namesake set
 *   FI/CZ/SK/SI/DK/NO/HR/PL/SE at 26 MB. Rebuild: `mailwoman gazetteer build postcode-geonames`.
 * - `postalcode-ni-osm.db` is **build-local**: OSM `addr:postcode` under ODbL, never published, so on any machine that
 *   did not build it the `existsSync` filter simply drops it and GB postcode queries behave as they did before. It is
 *   listed rather than special-cased because that filter IS the tier's enforcement. It is also the only GB-claiming
 *   shard in this list — the Code-Point Open shard is not here — so nothing competes with it for `BT` routing.
 */
export function wofShardPaths(
	dataRoot: string = mailwomanDataRoot()
): [string, string, string, string, string, string] {
	// TODO: Redo this as an object.
	return [
		resolvePath(dataRoot, "wof", "admin-global-priority.db"),
		resolvePath(dataRoot, "wof", "postalcode-us.db"),
		resolvePath(dataRoot, "wof", "postalcode-geonames-tail.db"),
		resolvePath(dataRoot, "wof", "postalcode-intl.db"),
		// #977: the NL PC6 full-postcode shard (CBS via PDOK; scripts/build-postalcode-nl-pc6.ts) — the
		// data the lookup's NL PC6 ladder ("1012 LG" → joined "1012LG" → 4-digit stem) resolves against.
		resolvePath(dataRoot, "wof", "postalcode-nl-pc6.db"),
		// Northern Ireland (BT) from OpenStreetMap — 4,757 of 50,032 live NI postcodes (9.5 %), the only
		// coverage that exists for the hole Code-Point Open leaves. ODbL, build-local, 2.5 MB. A miss on a
		// BT code means NOT ATTESTED IN OSM; since #1480 an unknown postcode abstains, so the shard is
		// strictly additive. Rebuild: `mailwoman gazetteer build postcode-ni-osm`.
		resolvePath(dataRoot, "wof", "postalcode-ni-osm.db"),
	]
}
