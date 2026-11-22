// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The admin build's GeoNames step adds GeoNames places and their alternate names to the admin gazetteer.
 *
 *   Thin composition over the canonical `@mailwoman/resolver-wof-sqlite` ingest functions.
 *   Directory defaults go through `dataRootPath`, because the data-root rule
 *   forbids a hardcoded lab path in shipped code.
 *
 *   The postal tail lives in `gazetteer-pipeline/postcode/geonames-tail.ts`
 *   (`mailwoman gazetteer build postcode-geonames`), which builds a standalone database.
 *   The admin gazetteer never wanted postcode rows added to it.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { GAP_SOURCE_TERMS, type UnmatchedPlace, type WOFPlaceIndex } from "#tools/pipeline/admin/sources/wof-match"

export interface AddGeonamesPlacesOptions {
	/**
	 * ISO-2 codes of the countries this step reads GeoNames places and alternate names
	 * for (`<CC>.txt` under {@link AddGeonamesPlacesOptions.geonamesDir}).
	 */
	countries: readonly string[]
	/**
	 * GeoNames per-country dump dir (download.geonames.org/export/dump).
	 *
	 * @defaultValue `<data-root>/geonames`
	 */
	geonamesDir?: PathBuilderLike
	/**
	 * AlternateNamesV2 dir (…/export/dump/alternatenames).
	 *
	 * @defaultValue `<data-root>/geonames-alternate`
	 */
	alternateDir?: PathBuilderLike
	/**
	 * Countries for which to also add the GeoNames A-class admin (pcli country + ADM1 regions)
	 * and link locality ancestry.
	 *
	 * Pass only zero-coverage locales (no WOF/Overture admin).
	 * See `geonamesAdminGapCountries()`.
	 *
	 * A zero-coverage locale gets no GeoNames A-class admin rows unless the lookup includes it.
	 */
	adminForCountries?: ReadonlySet<string>
	/**
	 * The WOF records to match against, and the receiver for places that match none.
	 */
	wof?: { index: WOFPlaceIndex; onGap: (gap: UnmatchedPlace) => void }
}

export interface AddGeonamesPlacesResult {
	placesIngested: number
}

/**
 * Add GeoNames places and their alternate names to an open unified staging DB.
 */
export async function addGeonamesPlaces(
	db: DatabaseClient<WOFDatabase>,
	opts: AddGeonamesPlacesOptions
): Promise<AddGeonamesPlacesResult> {
	// Imported here so loading this module doesn't evaluate resolver-wof-sqlite (the gazetteer-pipeline convention).
	const { ingestGeonamesAliases } = await import("@mailwoman/resolver-wof-sqlite/geonames")
	const geonamesDir = opts.geonamesDir ?? dataRootPath("geonames")
	const alternateDir = opts.alternateDir ?? dataRootPath("geonames-alternate")
	const wof = opts.wof

	const placesIngested = opts.countries.length
		? await ingestGeonamesAliases(db, [...opts.countries], geonamesDir, undefined, {
				alternateDir,
				adminForCountries: opts.adminForCountries,
				existing: wof && {
					match: (place) => wof.index.match(place),
					claimName: (match, country, name) => wof.index.claimName(match, country, name),
					onGap: ({ geonamesID, ...place }) =>
						wof.onGap({
							...place,
							source: "geonames",
							...GAP_SOURCE_TERMS.geonames,
							sourceID: String(geonamesID),
							geonamesID,
						}),
				},
			})
		: 0

	return { placesIngested }
}
