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
 * Build a path under the data root, e.g. `dataRootPath("db", "wof", "admin-global-priority.db")`.
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

/**
 * Default WOF extracts for FTS when `--wof-db` is not provided.
 *
 * Includes the global admin-priority extract plus postcode extracts.
 * Routing in `pickExtractForPlacetype` sends each postcode query to the extract
 * that claims that country (#920).
 *
 * All paths are under `dataRoot` (default: {@link dataRootPath}; callers may pass `--data-root`).
 * Returns a fresh array each call.
 *
 * Callers usually filter with `existsSync`, so missing files are skipped.
 *
 * This runtime list is intentionally smaller than `DEFAULT_POSTCODE_EXTRACTS`
 * (`mailwoman/gazetteer-pipeline/index.ts`), because these databases are attached live at boot.
 *
 * Notes:
 * - `postalcode-geonames-tail.db` now contains FI/CZ/SK/SI/DK/no/HR/PL/SE.
 * - `postalcode-ni-osm.db` is build-local (ODbL, OSM `addr:postcode`) and may be absent.
 *   A missing file is filtered out.
 *   It is the only GB-claiming extract here, and Code-Point Open is not in this list.
 */
export function wofExtractPaths(source: PathBuilderLike = dataRootPath()): string[] {
	return Object.values(wofExtractPathsByName(source))
}

/**
 * The extract set {@link wofExtractPaths} lists, keyed by role so a caller can
 * name one without indexing a tuple.
 */
export interface WOFExtractPaths {
	/**
	 * The global admin-priority extract — every admin lookup starts here.
	 */
	adminGlobalPriority: string
	/**
	 * US ZIP codes.
	 */
	postalcodeUS: string
	/**
	 * The nine-country namesake set FI/CZ/SK/SI/DK/no/HR/PL/SE (see {@link wofExtractPaths}).
	 */
	postalcodeGeonamesTail: string
	/**
	 * The international postcode extract (FR/DE/ES/IT/NL, and the others `pickExtractForPlacetype` routes here).
	 */
	postalcodeIntl: string
	/**
	 * The NL PC6 full-postcode extract (CBS via pdok; `scripts/build-postalcode-nl-pc6.ts`) — the data
	 * the lookup's NL PC6 ladder ("1012 LG" → joined "1012LG" → 4-digit stem) resolves against (#977).
	 */
	postalcodeNLPC6: string
	/**
	 * Northern Ireland (BT) from OpenStreetMap — 4,757 of 50,032 live NI postcodes (9.5 %),
	 * the only coverage that exists for the hole Code-Point Open leaves.
	 *
	 * ODbL, build-local, 2.5 MB.
	 * A miss on a BT code means not attested IN OSM.
	 *
	 * An unknown postcode abstains (#1480), so the extract is strictly additive.
	 * Rebuild: `mailwoman gazetteer build postcode-ni-osm`.
	 */
	postalcodeNIOSM: string
}

/**
 * {@link wofExtractPaths} as a named record, in the same order the runtime attaches them.
 */
export function wofExtractPathsByName(source: PathBuilderLike = dataRootPath()): WOFExtractPaths {
	const wof = databaseRootPath(source)("wof")

	return {
		adminGlobalPriority: wof("admin-global-priority.db").toString(),
		postalcodeUS: wof("postalcode-us.db").toString(),
		postalcodeGeonamesTail: wof("postalcode-geonames-tail.db").toString(),
		postalcodeIntl: wof("postalcode-intl.db").toString(),
		postalcodeNLPC6: wof("postalcode-nl-pc6.db").toString(),
		postalcodeNIOSM: wof("postalcode-ni-osm.db").toString(),
	}
}
