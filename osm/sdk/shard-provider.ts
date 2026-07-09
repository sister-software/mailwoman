/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The OSM rooftop shard provider — the injection point the geocode cascade consults for the opt-in
 *   international precision tier (#247). Given a data root, it opens `osm/address-points-<cc>-<cc>.db`
 *   with the country's street-normalization locale (so probe-side keying matches the shard the builder
 *   wrote) and caches the open handle per country. Wire its bound `for` into `GeocodeDeps.osmShards`.
 *
 *   ⚠ The shards it opens are ODbL OpenStreetMap Derived Databases — see `osm/README.md` for the
 *   distribution boundary and the lawyer sign-off gate before shipping any of them.
 */

import { existsSync } from "node:fs"

import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"

import { streetLocaleForCountry, supportedOSMCountries } from "./street-locale.ts"

/** What the cascade needs from an OSM shard — structurally a subset of mailwoman's `StateShards`. */
export interface OSMShards {
	addressPoints?: AddressPointSqliteLookup
}

/**
 * Opens + caches per-country OSM rooftop lookups. A non-US geocode consults `for(country)`; the first hit for a country
 * opens its shard (with the matching street locale) once, subsequent calls reuse it.
 */
export class OSMShardProvider {
	readonly #dataRoot: string
	readonly #cache = new Map<string, OSMShards>()

	constructor(dataRoot: string) {
		this.#dataRoot = dataRoot
	}

	#shardPath(countryCode: string): string {
		return `${this.#dataRoot}/osm/address-points-${countryCode}-${countryCode}.db`
	}

	/** Resolve the OSM shards for an ISO-3166 alpha-2 country, or `{}` when none is shipped/registered. */
	readonly for = (country: string): OSMShards => {
		const cc = country.toLowerCase()
		const cached = this.#cache.get(cc)

		if (cached) return cached

		let entry: OSMShards = {}

		// Only countries with a registered street locale AND an on-disk shard — never key with the wrong rules.
		if (supportedOSMCountries().includes(cc)) {
			const path = this.#shardPath(cc)

			if (existsSync(path)) {
				entry = { addressPoints: new AddressPointSqliteLookup(path, { streetLocale: streetLocaleForCountry(cc) }) }
			}
		}
		this.#cache.set(cc, entry)

		return entry
	}

	close(): void {
		for (const entry of this.#cache.values()) {
			entry.addressPoints?.close()
		}
		this.#cache.clear()
	}
}
