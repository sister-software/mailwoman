// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The geocode session a drop-in server answers from.
 *
 *   The Photon, Nominatim, OGC and MCP servers each build theirs here,
 *   so the four share one set of options.
 */

import type { LayerContribution } from "#geocode/contributions"
import { createGeocodeSessionOptions, GEOCODE_DEFAULT_LOCALE } from "#geocode/options"
import { createGeocodeSession, type GeocodeSession } from "#geocode/session"

/**
 * Builds a drop-in server's geocode session over `layers`.
 *
 * The session parses under the default locale and applies no country scope.
 * A server answers queries from every country, and a scope read from the locale would
 * resolve each query outside the United States to its namesake there.
 *
 * @param layers The data layers the server composes, in the order it consults their national sources.
 * @param candidateDB The path of a candidate gazetteer, in place of the one the data root resolves.
 * @throws When the gazetteer, the weights or a required layer can't be opened.
 */
export function createDropInGeocodeSession(
	layers: readonly LayerContribution[],
	candidateDB?: string | null
): Promise<GeocodeSession> {
	const options = createGeocodeSessionOptions({
		locale: GEOCODE_DEFAULT_LOCALE,
		countryScope: "none",
		...(candidateDB ? { candidateDB } : {}),
	})

	return createGeocodeSession(options, { layers })
}
