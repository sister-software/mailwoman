/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the databases this resolver reads live under the data root's `db/` group.
 *
 *   Each constant is a lazy path builder: it reads `$MAILWOMAN_DATA_ROOT` when a path is requested,
 *   so a later environment change or a test stub is honored.
 *   Call it with a filename, as in `wofDatabasePath("admin-global-priority.db")`.
 *   A caller holding another data root uses the matching `…DatabaseRoot(dataRoot)` function.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/wof`, which holds the admin, candidate and postcode databases.
 */
export function wofDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("wof")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/wof`.
 *
 * @see {@link wofDatabaseRoot} for another data root.
 */
export const wofDatabasePath: PathBuilder = wofDatabaseRoot(dataRootPath())

/**
 * `<dataRoot>/db/address-points`, which holds the national rooftop address-point databases.
 */
export function addressPointDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("address-points")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/address-points`.
 */
export const addressPointDatabasePath: PathBuilder = addressPointDatabaseRoot(dataRootPath())

/**
 * `<dataRoot>/db/interpolation`, which holds the street-segment interpolation databases.
 */
export function interpolationDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("interpolation")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/interpolation`.
 */
export const interpolationDatabasePath: PathBuilder = interpolationDatabaseRoot(dataRootPath())

/**
 * `<dataRoot>/db/poi`, which holds `poi.db` and its per-source builds.
 */
export function poiDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("poi")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/poi`.
 */
export const poiDatabasePath: PathBuilder = poiDatabaseRoot(dataRootPath())

/**
 * `$MAILWOMAN_DATA_ROOT/db/uprn`, which holds the UPRN point database.
 */
export const uprnDatabasePath: PathBuilder = databaseRootPath(dataRootPath())("uprn")

/**
 * `$MAILWOMAN_DATA_ROOT/db/nsul`, which holds the NSUL postcode layer and its source vintages.
 */
export const nsulDatabasePath: PathBuilder = databaseRootPath(dataRootPath())("nsul")

/**
 * Default WOF extracts for FTS when `--wof-db` is not provided.
 *
 * Includes the global admin-priority extract plus postcode extracts.
 * Routing in `pickExtractForPlacetype` sends each postcode query to the extract
 * that claims that country (#920).
 *
 * All paths are under `dataRoot` (default: `$MAILWOMAN_DATA_ROOT`; callers may pass `--data-root`).
 * Returns a fresh array each call.
 *
 * Callers usually filter with `existsSync`, so missing files are skipped.
 *
 * This runtime list is intentionally smaller than `DEFAULT_POSTCODE_DATABASES`
 * (`mailwoman/gazetteer-pipeline/index.ts`), because these databases are attached live at boot.
 *
 * Notes:
 * - `postalcode-geonames-tail.db` now contains FI/CZ/SK/SI/DK/no/HR/PL/SE.
 * - `postalcode-ni-osm.db` is build-local (ODbL, OSM `addr:postcode`) and may be absent.
 *   A missing file is filtered out.
 *   It is the only GB-claiming extract here, and Code-Point Open is not in this list.
 */
export function wofExtractPaths(dataRoot: PathBuilderLike = dataRootPath()): string[] {
	return Object.values(wofExtractPathsByName(dataRoot))
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
export function wofExtractPathsByName(dataRoot: PathBuilderLike = dataRootPath()): WOFExtractPaths {
	const wof = wofDatabaseRoot(dataRoot)

	return {
		adminGlobalPriority: wof("admin-global-priority.db").toString(),
		postalcodeUS: wof("postalcode-us.db").toString(),
		postalcodeGeonamesTail: wof("postalcode-geonames-tail.db").toString(),
		postalcodeIntl: wof("postalcode-intl.db").toString(),
		postalcodeNLPC6: wof("postalcode-nl-pc6.db").toString(),
		postalcodeNIOSM: wof("postalcode-ni-osm.db").toString(),
	}
}
