// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The geocode session a drop-in server answers from.
 *
 *   The Photon, Nominatim, OGC and MCP servers each build theirs here,
 *   so the four share one set of options.
 */

import type { LayerContribution } from "#geocode/contributions"
import { createGeocodeSessionOptions, type GeocodeSessionOptionsInput } from "#geocode/options"
import { createGeocodeSession, type GeocodeSession } from "#geocode/session"

/**
 * What a drop-in server states about its session: where its gazetteer is, and its locale.
 *
 * A server that states no locale leaves it out, and the session records its locale as the default.
 */
export type DropInSessionOptions = Pick<GeocodeSessionOptionsInput, "candidateDB" | "resolveDB" | "locale">

/**
 * Builds a drop-in server's geocode session over `layers`.
 *
 * The session applies no country scope.
 * A server answers queries from every country, and a scope read from the locale would
 * resolve each query outside the United States to its namesake there.
 *
 * @param layers The data layers the server composes, in the order it consults their national sources.
 * @param stated The gazetteer paths and the locale the server states,
 * in place of the ones the data root and the defaults give.
 * @throws When the gazetteer, the weights or a required layer can't be opened.
 */
export function createDropInGeocodeSession(
	layers: readonly LayerContribution[],
	stated: DropInSessionOptions = {}
): Promise<GeocodeSession> {
	return createGeocodeSession(createGeocodeSessionOptions({ ...stated, countryScope: "none" }), { layers })
}
