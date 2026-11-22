// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The forward geocoder behind `mailwoman-ogc serve`: the gazetteer, the classifier and the
 *   rooftop providers the server opens at startup, and the geocode of one query over them.
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

import type { AncestorsOf } from "#index"

/**
 * What `mailwoman-ogc serve` opens to answer `/search` and to list its collections.
 */
export interface OGCGeocoder {
	/**
	 * The gazetteer databases the resolver reads.
	 */
	gazetteer: GazetteerPaths
	/**
	 * The gazetteer's own ancestry reader, absent when the gazetteer backend reads no ancestry.
	 */
	ancestorsOf: AncestorsOf | undefined
	/**
	 * The address-point and interpolation databases of each United States state.
	 */
	extracts: USStateDatabaseProvider
	/**
	 * The national open register and the OpenStreetMap tier, read from one generation of the active selection.
	 */
	rooftops: ServingRooftopProviders
	/**
	 * Geocodes one query.
	 */
	geocode(query: string): Promise<GeocodeResult>
}

/**
 * Opens the gazetteer, the classifier and the rooftop providers, and ends the process
 * when the gazetteer or the classifier is absent.
 *
 * @param candidateDBFlag The `--candidate-db` value, or `null` to read the conventional path.
 */
export async function openOGCGeocoder(candidateDBFlag: string | null): Promise<OGCGeocoder> {
	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const gazetteer = await resolveGazetteerOrExit(candidateDBFlag)
	const { candidateDB, wofPaths } = gazetteer
	const classifier = await loadClassifierOrExit()

	const backend = await createResolverBackend(resolverMod, { wofPaths, candidateDB })
	const resolver = createWOFResolver(backend)
	const extracts = await USStateDatabaseProvider.create(resolverMod, dataRootPath())
	// The national open register ahead of the OpenStreetMap tier, read from one generation
	// of the active selection, as the Photon and Nominatim servers read them.
	const rooftops = await openServingRooftopProviders(dataRootPath())

	return {
		gazetteer,
		ancestorsOf: backend.ancestors?.bind(backend),
		extracts,
		rooftops,
		// The call sets no country constraint, so the placer routes the query to its own country.
		geocode: (query) =>
			geocodeAddress(query, {
				classifier,
				resolver,
				databases: extracts.for,
				nationalDatabases: rooftops.national.for,
				...(rooftops.osm ? { osmDatabases: rooftops.osm.for } : {}),
			}),
	}
}
