// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The forward geocoder behind `mailwoman-photon serve`: the data layers the server
 *   composes, and the geocode of one query through its session.
 *
 *   The module is separate from `main.ts` because that file runs the command line when it loads.
 */

import type { GeocodeResult } from "@mailwoman/core/geocode"
import { type DropInGeocoder, openDropInGeocoder } from "mailwoman/cli/kit/dropin"
import type { LayerContribution } from "mailwoman/geocode/contributions"
import type { GeocodeRequestOptions } from "mailwoman/geocode/session"
import { banLayer, forkEntityProbe, observationRoutes, osmLayer, regionDatabases } from "mailwoman/services/entry/node"

/**
 * The data layers Photon composes.
 *
 * The server consults the national open register (BAN) and then the OpenStreetMap tier.
 * It leaves national Overture out.
 *
 * That order is the one it had before the active selection existed.
 */
const PHOTON_LAYERS: readonly LayerContribution[] = [
	banLayer,
	osmLayer,
	regionDatabases,
	forkEntityProbe,
	observationRoutes,
]

/**
 * What `mailwoman-photon serve` opens to answer `/api`.
 */
export interface PhotonGeocoder extends DropInGeocoder {
	/**
	 * Geocodes one query as a fragment a person is typing, preferring candidates near `bias`.
	 */
	geocode(query: string, bias?: GeocodeRequestOptions["bias"]): Promise<GeocodeResult>
}

/**
 * Opens the gazetteer and the server's session, and ends the process when either is unavailable.
 *
 * @param candidateDBFlag The `--candidate-db` value, or `null` to read the conventional path.
 */
export async function openPhotonGeocoder(candidateDBFlag: string | null): Promise<PhotonGeocoder> {
	const opened = await openDropInGeocoder(candidateDBFlag, PHOTON_LAYERS)

	return {
		...opened,
		// Photon is an autocomplete front where a human types fragments.
		geocode: async (query, bias) =>
			(await opened.session.geocode(query, { inputMode: "fragmented", ...(bias ? { bias } : {}) })).result,
	}
}
