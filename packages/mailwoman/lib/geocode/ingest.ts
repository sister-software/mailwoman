// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The geocoder a record ingest runs, answered by a geocode session.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { type GeocodeAddress, geocodeAddressVia } from "@mailwoman/entity-resolution"

import type { GeocodeSession } from "#geocode/session"

/**
 * Builds the record matcher's {@link GeocodeAddress} over a geocode session.
 *
 * Each address is parsed once: the postal address is decoded from the tree the session
 * resolved, so the components and the coordinate describe the same parse.
 *
 * The session stays the caller's to dispose.
 *
 * @param country The country every address is formatted under, or the parsed
 * `country` component when omitted.
 */
export function ingestGeocoderOf(session: Pick<GeocodeSession, "geocode">, country?: string): GeocodeAddress {
	return geocodeAddressVia({
		parseAndGeocode: async (raw) => {
			const { result, tree } = await session.geocode(raw)

			return { components: decodeAsJSON(tree), geo: result }
		},
		...(country ? { country } : {}),
	})
}
