/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The GeoNames ALIAS fold for the admin gazetteer: the bilingual/alt-name tail (#743/#193 — the
 *   Karjaa↔Karis class, ids @ 9e12). Thin composition over the canonical
 *   `@mailwoman/resolver-wof-sqlite` ingest functions; directory defaults go through `dataRootPath` —
 *   the previous script hardcoded the lab playpen path for the dump dir, which the data-root rule
 *   forbids in shipped code.
 *
 *   NOT the postal fold. This file carried `postalCountries`/`postalDir` passthroughs to
 *   `ingestGeonamesPostal` from 2026-07 to 2026-08-05 with NO CALLER anywhere in the tree: #1027
 *   deleted `build-unified-wof`'s Phase 2d (the only invocation) and moved its parameters here
 *   instead of its behaviour, leaving a signature that pointed readers hunting the
 *   `postalcode-geonames-tail.db` builder at the wrong module. Deleted. The postal tail's real home
 *   is `gazetteer-pipeline/postcode/geonames-tail.ts` (`mailwoman gazetteer build postcode-geonames`),
 *   which builds a STANDALONE shard — the admin gazetteer never wanted postcode rows folded into it.
 */

import type { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"

export interface FoldGeonamesOptions {
	/**
	 * ISO-2 codes for the alias fold (`<CC>.txt` under {@link FoldGeonamesOptions.geonamesDir}).
	 */
	countries: readonly string[]
	/**
	 * GeoNames per-country dump dir (download.geonames.org/export/dump). Default `<data-root>/geonames`.
	 */
	geonamesDir?: string
	/**
	 * AlternateNamesV2 dir (…/export/dump/alternatenames). Default `<data-root>/geonames-alternate`.
	 */
	alternateDir?: string
	/**
	 * #267/#1026: countries for which to ALSO fold the GeoNames A-class admin (PCLI country + ADM1 regions) and link
	 * locality ancestry. Pass ONLY zero-coverage locales (no WOF/Overture admin) — see `geonamesAdminGapCountries()`.
	 * Omitting this is what flattened 95 countries' nodes (#1026).
	 */
	adminForCountries?: ReadonlySet<string>
}

export interface FoldGeonamesResult {
	placesIngested: number
}

/**
 * Fold GeoNames aliases into an open unified staging DB.
 */
export async function foldGeonames(db: DatabaseSync, opts: FoldGeonamesOptions): Promise<FoldGeonamesResult> {
	// resolver-wof-sqlite is an OPTIONAL peer of mailwoman — lazy import (the gazetteer-pipeline convention).
	const { ingestGeonamesAliases } = await import("@mailwoman/resolver-wof-sqlite/geonames-aliases")
	const geonamesDir = opts.geonamesDir ?? String(dataRootPath("geonames"))
	const alternateDir = opts.alternateDir ?? String(dataRootPath("geonames-alternate"))

	const placesIngested = opts.countries.length
		? await ingestGeonamesAliases(db, [...opts.countries], geonamesDir, undefined, {
				alternateDir,
				adminForCountries: opts.adminForCountries,
			})
		: 0

	return { placesIngested }
}
