// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The forward geocoder behind `mailwoman-photon serve`: the gazetteer, the classifier
 *   and the rooftop providers the server opens at startup, and the geocode of one query over them.
 *
 *   The module is separate from `main.ts` because that file runs the command line when it loads.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import { createWOFResolver } from "@mailwoman/resolver"
import { type GazetteerPaths, loadClassifierOrExit, resolveGazetteerOrExit } from "mailwoman/cli/kit/dropin"
import { geocodeAddress, USStateDatabaseProvider } from "mailwoman/geocode"
import type { GeocodeDeps } from "mailwoman/geocode/core"
import { openServingRooftopProviders, type ServingRooftopProviders } from "mailwoman/geocode/serving-layers"
import { createResolverBackend } from "mailwoman/resolver-backend"

/**
 * What `mailwoman-photon serve` opens to answer `/api`.
 */
export interface PhotonGeocoder {
	/**
	 * The gazetteer databases the resolver reads.
	 */
	gazetteer: GazetteerPaths
	/**
	 * The national open register and the OpenStreetMap tier, read from one generation of the active selection.
	 */
	rooftops: ServingRooftopProviders
	/**
	 * Geocodes one query as a fragment a person is typing, preferring candidates near `bias`.
	 */
	geocode(query: string, bias?: GeocodeDeps["bias"]): Promise<GeocodeResult>
}

/**
 * Opens the gazetteer, the classifier and the rooftop providers, and ends the process
 * when the gazetteer or the classifier is absent.
 *
 * @param candidateDBFlag The `--candidate-db` value, or `null` to read the conventional path.
 */
export async function openPhotonGeocoder(candidateDBFlag: string | null): Promise<PhotonGeocoder> {
	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const gazetteer = await resolveGazetteerOrExit(candidateDBFlag)
	const { candidateDB, wofPaths } = gazetteer
	const classifier = await loadClassifierOrExit()

	const backend = await createResolverBackend(resolverMod, { wofPaths, candidateDB })
	const resolver = createWOFResolver(backend)
	const extracts = await USStateDatabaseProvider.create(resolverMod, dataRootPath())
	// National open-register rooftop tier: BAN-FR ahead of the OSM tier for a non-US parse,
	// a no-op when the extract is absent.
	// Both read one generation of the active selection, else their conventional paths.
	const rooftops = await openServingRooftopProviders(dataRootPath())
	const banExtracts = rooftops.national
	const osmExtracts = rooftops.osm

	return {
		gazetteer,
		rooftops,
		// No country constraint lets the placer route the query's own country.
		// A hard-coded `US` value here would resolve every non-US query to its US namesake.
		geocode: (query, bias) =>
			geocodeAddress(query, {
				classifier,
				resolver,
				databases: extracts.for,
				nationalDatabases: banExtracts.for,
				...(osmExtracts ? { osmDatabases: osmExtracts.for } : {}),
				bias,
				// Photon is an autocomplete front where a human types fragments.
				inputMode: "fragmented",
			}),
	}
}
