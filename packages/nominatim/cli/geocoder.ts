// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The forward geocoder behind `mailwoman-nominatim serve`: the data layers the
 *   server composes, and the geocode of one query through its session.
 *
 *   The module is separate from `main.ts` because that file runs the command line when it loads.
 */

import type { GeocodeResult } from "@mailwoman/core/geocode"
import { type DropInGeocoder, openDropInGeocoder } from "mailwoman/cli/kit/dropin"
import type { LayerContribution } from "mailwoman/geocode/contributions"
import { banLayer, forkEntityProbe, observationRoutes, osmLayer, regionDatabases } from "mailwoman/services/entry/node"

/**
 * The data layers Nominatim composes.
 *
 * The server consults the national open register (BAN) and then the OpenStreetMap tier.
 * It leaves national Overture out.
 *
 * That order is the one it had before the active selection existed.
 */
const NOMINATIM_LAYERS: readonly LayerContribution[] = [
	banLayer,
	osmLayer,
	regionDatabases,
	forkEntityProbe,
	observationRoutes,
]

/**
 * What `mailwoman-nominatim serve` opens to answer `/search`.
 */
export interface NominatimGeocoder extends DropInGeocoder {
	/**
	 * Geocodes one query.
	 *
	 * @param country An ISO 3166-1 code the caller restricts the answer to,
	 * even to the point of zero results.
	 */
	geocode(query: string, country?: string): Promise<GeocodeResult>
}

/**
 * Opens the gazetteer and the server's session, and ends the process when either is unavailable.
 *
 * @param candidateDBFlag The `--candidate-db` value, or `null` to read the conventional path.
 */
export async function openNominatimGeocoder(candidateDBFlag: string | null): Promise<NominatimGeocoder> {
	const opened = await openDropInGeocoder(candidateDBFlag, NOMINATIM_LAYERS)

	return {
		...opened,
		geocode: async (query, country) =>
			(await opened.session.geocode(query, country ? { defaultCountry: country } : {})).result,
	}
}
