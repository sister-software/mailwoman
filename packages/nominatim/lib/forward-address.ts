/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A forward geocode result as Nominatim's address block: the parse's named slots first, then the resolved
 *   ancestry labelled by tag the way Nominatim labels each ancestor by its address rank — a Japanese municipality is
 *   `city`, a prefecture `state`, a 大字 / 町名 `suburb`. The native `locality` / `region` slots stay what the parse said;
 *   only this compatibility surface reads the JP tiers into the Latin keys.
 */

import type { GeocodeResult } from "mailwoman/geocode"

import type { NominatimAddressDetails, ResolvedAddress } from "#index"

/**
 * Resolved tag → Nominatim address key, for a forward result's `hierarchy`.
 */
export const TAG_TO_KEY: Record<string, keyof NominatimAddressDetails> = {
	locality: "city",
	municipality: "city",
	dependent_locality: "suburb",
	district: "suburb",
	subregion: "county",
	region: "state",
	prefecture: "state",
	country: "country",
}

function joinNonEmpty(...parts: Array<string | undefined>): string {
	return parts.filter((part) => part !== undefined && part.length > 0).join(", ")
}

/**
 * Map a forward geocode result (admin + coordinate) into the formatter's neutral shape.
 */
export function forwardToResolved(r: GeocodeResult): ResolvedAddress {
	const address: NominatimAddressDetails = {}

	if (r.locality) {
		address.city = r.locality
	}

	if (r.region) {
		address.state = r.region
	}

	if (r.postcode) {
		address.postcode = r.postcode
	}

	// The resolved ancestry fills what the slots did not: a JP result carries `municipality` and `prefecture` in
	// `hierarchy` and nothing in `locality` / `region`. Most specific first, so the first name per key wins.
	for (const h of r.hierarchy) {
		const key = TAG_TO_KEY[h.tag]

		if (key && !address[key]) {
			address[key] = h.name || h.value
		}
	}

	return {
		lat: r.lat,
		lon: r.lon,
		address,
		displayName: joinNonEmpty(address.city, address.state, address.postcode, address.country) || r.input,
	}
}
