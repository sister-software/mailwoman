/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GeoNames folds for the admin gazetteer: the bilingual/alt-name alias tail (#743/#193 — the
 *   Karjaa↔Karis class, ids @ 9e12) and the postal-code tail (#920). Thin composition over the
 *   canonical `@mailwoman/resolver-wof-sqlite` ingest functions; directory defaults go through
 *   `dataRootPath` — the previous script hardcoded the lab playpen path for the dump dir, which the
 *   data-root rule forbids in shipped code.
 */

import type { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"

export interface FoldGeonamesOptions {
	/** ISO-2 codes for the alias fold (`<CC>.txt` under {@link FoldGeonamesOptions.geonamesDir}). */
	countries: readonly string[]
	/** GeoNames per-country dump dir (download.geonames.org/export/dump). Default `<data-root>/geonames`. */
	geonamesDir?: string
	/** AlternateNamesV2 dir (…/export/dump/alternatenames). Default `<data-root>/geonames-alternate`. */
	alternateDir?: string
	/** ISO-2 codes for the POSTAL fold (#920). Omit to skip. */
	postalCountries?: readonly string[]
	/** GeoNames postal dump dir (…/export/zip). Default `<data-root>/geonames-postal`. */
	postalDir?: string
}

export interface FoldGeonamesResult {
	placesIngested: number
	postalIngested: number
}

/** Fold GeoNames aliases (+ optionally postal codes) into an open unified staging DB. */
export async function foldGeonames(db: DatabaseSync, opts: FoldGeonamesOptions): Promise<FoldGeonamesResult> {
	// resolver-wof-sqlite is an OPTIONAL peer of mailwoman — lazy import (the gazetteer-pipeline convention).
	const { ingestGeonamesAliases } = await import("@mailwoman/resolver-wof-sqlite/geonames-aliases")
	const { ingestGeonamesPostal } = await import("@mailwoman/resolver-wof-sqlite/geonames-postal")
	const geonamesDir = opts.geonamesDir ?? String(dataRootPath("geonames"))
	const alternateDir = opts.alternateDir ?? String(dataRootPath("geonames-alternate"))
	const placesIngested =
		opts.countries.length > 0
			? ingestGeonamesAliases(db, [...opts.countries], geonamesDir, undefined, { alternateDir })
			: 0

	let postalIngested = 0

	if (opts.postalCountries && opts.postalCountries.length > 0) {
		const postalDir = opts.postalDir ?? String(dataRootPath("geonames-postal"))
		postalIngested = ingestGeonamesPostal(db, [...opts.postalCountries], postalDir).inserted
	}

	return { placesIngested, postalIngested }
}
