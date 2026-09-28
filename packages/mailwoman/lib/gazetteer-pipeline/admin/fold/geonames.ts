/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The GeoNames alias fold for the admin gazetteer. Thin composition over the canonical
 *   `@mailwoman/resolver-wof-sqlite` ingest functions. Directory defaults go through `dataRootPath`,
 *   because the data-root rule forbids a hardcoded lab path in shipped code.
 *
 *   The postal tail lives in `gazetteer-pipeline/postcode/geonames-tail.ts`
 *   (`mailwoman gazetteer build postcode-geonames`), which builds a standalone database. The admin
 *   gazetteer never wanted postcode rows folded into it.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

export interface FoldGeonamesOptions {
	/**
	 * ISO-2 codes for the alias fold (`<CC>.txt` under {@link FoldGeonamesOptions.geonamesDir}).
	 */
	countries: readonly string[]
	/**
	 * GeoNames per-country dump dir (download.geonames.org/export/dump).
	 *
	 * Default `<data-root>/geonames`.
	 */
	geonamesDir?: PathBuilderLike
	/**
	 * AlternateNamesV2 dir (…/export/dump/alternatenames).
	 *
	 * Default `<data-root>/geonames-alternate`.
	 */
	alternateDir?: PathBuilderLike
	/**
	 * Countries for which to also fold the GeoNames A-class admin (pcli country + ADM1 regions) and link
	 * locality ancestry.
	 *
	 * Pass only zero-coverage locales (no WOF/Overture admin). See `geonamesAdminGapCountries()`.
	 *
	 * Omitting this leaves a zero-coverage locale's nodes without the A-class admin fold.
	 */
	adminForCountries?: ReadonlySet<string>
}

export interface FoldGeonamesResult {
	placesIngested: number
}

/**
 * Fold GeoNames aliases into an open unified staging DB.
 */
export async function foldGeonames(
	db: DatabaseClient<WOFDatabase>,
	opts: FoldGeonamesOptions
): Promise<FoldGeonamesResult> {
	// Imported here so loading this module does not evaluate resolver-wof-sqlite (the gazetteer-pipeline convention).
	const { ingestGeonamesAliases } = await import("@mailwoman/resolver-wof-sqlite/geonames")
	const geonamesDir = opts.geonamesDir ?? dataRootPath("geonames")
	const alternateDir = opts.alternateDir ?? dataRootPath("geonames-alternate")

	const placesIngested = opts.countries.length
		? await ingestGeonamesAliases(db, [...opts.countries], geonamesDir, undefined, {
				alternateDir,
				adminForCountries: opts.adminForCountries,
			})
		: 0

	return { placesIngested }
}
