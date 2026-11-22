// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The forward geocoder behind `mailwoman-nominatim serve`: the gazetteer, the classifier
 *   and the rooftop providers the server opens at startup, and the geocode of one query over them.
 *
 *   The module is separate from `main.ts` because that file runs the command line when it loads.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import { createWOFResolver } from "@mailwoman/resolver"
import { type GazetteerPaths, loadClassifierOrExit, resolveGazetteerOrExit } from "mailwoman/cli/kit/dropin"
import { geocodeAddress, USStateDatabaseProvider } from "mailwoman/geocode"
import { openServingRooftopProviders, type ServingRooftopProviders } from "mailwoman/geocode/serving-layers"
import { createResolverBackend } from "mailwoman/resolver-backend"

/**
 * What `mailwoman-nominatim serve` opens to answer `/search`.
 */
export interface NominatimGeocoder {
	/**
	 * The gazetteer databases the resolver reads.
	 */
	gazetteer: GazetteerPaths
	/**
	 * The national open register and the OpenStreetMap tier, read from one generation of the active selection.
	 */
	rooftops: ServingRooftopProviders
	/**
	 * Geocodes one query.
	 *
	 * @param country An ISO 3166-1 code the caller restricts the answer to,
	 * even to the point of zero results.
	 */
	geocode(query: string, country?: string): Promise<GeocodeResult>
}

/**
 * Opens the gazetteer, the classifier and the rooftop providers, and ends the process
 * when the gazetteer or the classifier is absent.
 *
 * @param candidateDBFlag The `--candidate-db` value, or `null` to read the conventional path.
 */
export async function openNominatimGeocoder(candidateDBFlag: string | null): Promise<NominatimGeocoder> {
	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const gazetteer = await resolveGazetteerOrExit(candidateDBFlag)
	const { candidateDB, wofPaths } = gazetteer
	const classifier = await loadClassifierOrExit()

	const backend = await createResolverBackend(resolverMod, { wofPaths, candidateDB })
	const resolver = createWOFResolver(backend)
	const extracts = await USStateDatabaseProvider.create(resolverMod, dataRootPath())
	// National open-register rooftop tier: BAN-FR ahead of the OSM tier for a non-US parse.
	// A no-op when the extract isn't on disk, so the endpoint falls back to the OSM tier without an error.
	// Both read one generation of the active selection, else their conventional paths.
	const rooftops = await openServingRooftopProviders(dataRootPath())
	const banExtracts = rooftops.national
	const osmExtracts = rooftops.osm

	return {
		gazetteer,
		rooftops,
		geocode: (query, country) =>
			geocodeAddress(query, {
				classifier,
				resolver,
				databases: extracts.for,
				nationalDatabases: banExtracts.for,
				...(osmExtracts ? { osmDatabases: osmExtracts.for } : {}),
				...(country ? { defaultCountry: { country, source: "caller" } } : {}),
			}),
	}
}
