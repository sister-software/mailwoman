/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The BAN rooftop shard provider — the injection point the geocode cascade consults for the national
 *   open-register precision tier (#1012), AHEAD of the community OSM tier. Given a data root, it opens
 *   `ban/address-points-<cc>.db` with the country's street-normalization locale (so probe-side keying
 *   matches the shard the builder wrote) and caches the open handle per country. Wire its bound `for`
 *   into `GeocodeDeps.nationalShards`.
 *
 *   BAN is a French national register, so the registry is deliberately FR-only today; the shape
 *   generalises to any other national open register (the coverage story, one country at a time).
 */

import { existsSync } from "node:fs"

import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"

import { streetLocaleForBANCountry, supportedBANCountries } from "./street-locale.js"

/** What the cascade needs from a BAN shard — structurally a subset of mailwoman's `StateShards`. */
export interface BANShards {
	addressPoints?: AddressPointSqliteLookup
}

/**
 * Opens + caches per-country BAN rooftop lookups. A non-US geocode consults `for(country)`; the first hit for a country
 * opens its shard (with the matching street locale) once, subsequent calls reuse it.
 */
export class BANShardProvider {
	readonly #dataRoot: string
	readonly #cache = new Map<string, BANShards>()

	constructor(dataRoot: string) {
		this.#dataRoot = dataRoot
	}

	#shardPath(countryCode: string): string {
		return `${this.#dataRoot}/ban/address-points-${countryCode}.db`
	}

	/** Resolve the BAN shards for an ISO-3166 alpha-2 country, or `{}` when none is shipped/registered. */
	readonly for = (country: string): BANShards => {
		const cc = country.toLowerCase()
		const cached = this.#cache.get(cc)

		if (cached) return cached

		let entry: BANShards = {}

		// Only countries with a registered street locale AND an on-disk shard — never key with the wrong rules.
		if (supportedBANCountries().includes(cc)) {
			const path = this.#shardPath(cc)

			if (existsSync(path)) {
				entry = { addressPoints: new AddressPointSqliteLookup(path, { streetLocale: streetLocaleForBANCountry(cc) }) }
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
