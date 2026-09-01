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

import { pathExists } from "@mailwoman/core/fs/readers"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import { join } from "path-ts"

import { streetLocaleForCountry, supportedOSMCountries } from "#sdk/street-locale"

/**
 * What the cascade needs from an OSM shard — structurally a subset of mailwoman's `RegionDatabases`.
 */
export interface OSMShards {
	addressPoints?: AddressPointSqliteLookup
}

/**
 * Opens + caches per-country OSM rooftop lookups. A non-US geocode consults `for(country)`; the first hit for a country
 * opens its shard (with the matching street locale) once, subsequent calls reuse it.
 *
 * `for` is synchronous, so on-disk existence is probed asynchronously ONCE instead of per call: {@linkcode warm} awaits
 * `pathExists` for every supported country's shard and records what exists; `for` consults that map. Prefer
 * {@linkcode OSMRegionDatabaseProvider.create}, which constructs AND warms before answering — a provider constructed
 * directly must be warmed before its first `for`, or it answers `{}` for every country.
 */
export class OSMRegionDatabaseProvider implements Disposable {
	readonly #dataRoot: string
	readonly #cache = new Map<string, OSMShards>()
	/**
	 * Shard paths {@linkcode warm} observed on disk — the synchronous existence source `for` consults.
	 */
	readonly #onDisk = new Set<string>()
	#warmPromise?: Promise<void>

	constructor(dataRoot: string) {
		this.#dataRoot = dataRoot
	}

	/**
	 * Construct a provider and warm its existence map before answering. The constructor cannot await the probe, so this
	 * static factory does; a caller that constructs directly must {@linkcode warm} before the first `for`.
	 */
	static async create(dataRoot: string): Promise<OSMRegionDatabaseProvider> {
		const provider = new OSMRegionDatabaseProvider(dataRoot)

		await provider.warm()

		return provider
	}

	#shardPath(countryCode: string): string {
		return join(this.#dataRoot, "osm", `address-points-${countryCode}-${countryCode}.db`)
	}

	/**
	 * Preload shard existence for every country the provider may be asked for.
	 *
	 * Awaits `pathExists` for each supported country's rooftop shard, recording the paths that exist so `for` never
	 * touches the filesystem. Safe to call more than once: the probe promise is cached, so every caller (and
	 * {@linkcode OSMRegionDatabaseProvider.create}) shares one pass.
	 */
	readonly warm = (): Promise<void> => (this.#warmPromise ??= this.#probeShards())

	async #probeShards(): Promise<void> {
		for (const cc of supportedOSMCountries()) {
			const path = this.#shardPath(cc)

			if (await pathExists(path)) {
				this.#onDisk.add(path)
			}
		}
	}

	/**
	 * Resolve the OSM shards for an ISO-3166 alpha-2 country, or `{}` when none is shipped/registered.
	 *
	 * Synchronous: the on-disk answer comes from the map {@linkcode warm} preloaded, so no filesystem probe runs per call.
	 */
	readonly for = (country: string): OSMShards => {
		const cc = country.toLowerCase()
		const cached = this.#cache.get(cc)

		if (cached) return cached

		let entry: OSMShards = {}

		// Only countries with a registered street locale AND an on-disk shard — never key with the wrong rules.
		if (supportedOSMCountries().includes(cc)) {
			const path = this.#shardPath(cc)

			if (this.#onDisk.has(path)) {
				entry = { addressPoints: new AddressPointSqliteLookup(path, { streetLocale: streetLocaleForCountry(cc) }) }
			}
		}

		this.#cache.set(cc, entry)

		return entry
	};

	[Symbol.dispose](): void {
		for (const entry of this.#cache.values()) {
			entry.addressPoints?.[Symbol.dispose]()
		}

		this.#cache.clear()
	}
}
