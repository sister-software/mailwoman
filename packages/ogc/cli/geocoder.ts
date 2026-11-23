// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The forward geocoder behind `mailwoman-ogc serve`: the data layers the server composes,
 *   and the geocode of one query through its session.
 *
 *   The module is separate from `main.ts` because that file runs the command line when it loads.
 */

import type { GeocodeResult } from "@mailwoman/core/geocode"
import { type DropInGeocoder, openDropInGeocoder } from "mailwoman/cli/kit/dropin"
import type { LayerContribution } from "mailwoman/geocode/layers/contributions"
import { banLayer, forkEntityProbe, observationRoutes, osmLayer, regionDatabases } from "mailwoman/services/entry/node"

/**
 * The data layers the OGC server composes.
 *
 * The server consults the national open register (BAN) and then the OpenStreetMap tier,
 * as the Photon and Nominatim servers do.
 * It leaves national Overture out, so each collection it lists is one its `/search` reads.
 */
const OGC_LAYERS: readonly LayerContribution[] = [
	banLayer,
	osmLayer,
	regionDatabases,
	forkEntityProbe,
	observationRoutes,
]

/**
 * What `mailwoman-ogc serve` opens to answer `/search` and to list its collections.
 */
export interface OGCGeocoder extends DropInGeocoder {
	/**
	 * Geocodes one query.
	 */
	geocode(query: string): Promise<GeocodeResult>
}

/**
 * Opens the gazetteer and the server's session, and ends the process when either is unavailable.
 *
 * @param candidateDBFlag The `--candidate-db` value, or `null` to read the conventional path.
 */
export async function openOGCGeocoder(candidateDBFlag: string | null): Promise<OGCGeocoder> {
	const opened = await openDropInGeocoder(candidateDBFlag, OGC_LAYERS)

	return { ...opened, geocode: async (query) => (await opened.session.geocode(query)).result }
}
