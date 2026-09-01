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

import { pathExists } from "@mailwoman/core/fs/readers"
import { AddressPointSqliteLookup, StreetCentroidSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import { join } from "path-ts"

import { streetLocaleForBANCountry, supportedBANCountries } from "#sdk/street-locale"

/**
 * What the cascade needs from a BAN shard — structurally a subset of mailwoman's `RegionDatabases`.
 */
export interface BANShards {
	addressPoints?: AddressPointSqliteLookup
	/**
	 * The #1042 derived street-centroid tier — a `GROUP BY street` roll-up, for a street-only query (no house number).
	 */
	streetCentroids?: StreetCentroidSqliteLookup
}

/**
 * Opens + caches per-country BAN rooftop lookups. A non-US geocode consults `for(country)`; the first hit for a country
 * opens its shard (with the matching street locale) once, subsequent calls reuse it.
 *
 * `for` is synchronous, so on-disk existence is probed asynchronously ONCE instead of per call: {@linkcode warm} awaits
 * `pathExists` for every supported country × shard-tier combination and records what exists; `for` consults that map.
 * Prefer {@linkcode BANRegionDatabaseProvider.create}, which constructs AND warms before answering — a provider
 * constructed directly must be warmed before its first `for`, or it answers `{}` for every country.
 */
export class BANRegionDatabaseProvider implements Disposable {
	readonly #dataRoot: string
	readonly #cache = new Map<string, BANShards>()
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
	static async create(dataRoot: string): Promise<BANRegionDatabaseProvider> {
		const provider = new BANRegionDatabaseProvider(dataRoot)

		await provider.warm()

		return provider
	}

	#shardPath(countryCode: string): string {
		return join(this.#dataRoot, "ban", `address-points-${countryCode}.db`)
	}

	#streetCentroidPath(countryCode: string): string {
		return join(this.#dataRoot, "ban", `street-centroids-${countryCode}.db`)
	}

	/**
	 * Preload shard existence for every country the provider may be asked for.
	 *
	 * Awaits `pathExists` for each supported country's rooftop shard and its derived street-centroid tier, recording the
	 * paths that exist so `for` never touches the filesystem. Safe to call more than once: the probe promise is cached,
	 * so every caller (and {@linkcode BANRegionDatabaseProvider.create}) shares one pass.
	 */
	readonly warm = (): Promise<void> => (this.#warmPromise ??= this.#probeShards())

	async #probeShards(): Promise<void> {
		for (const cc of supportedBANCountries()) {
			for (const path of [this.#shardPath(cc), this.#streetCentroidPath(cc)]) {
				if (await pathExists(path)) {
					this.#onDisk.add(path)
				}
			}
		}
	}

	/**
	 * Resolve the BAN shards for an ISO-3166 alpha-2 country, or `{}` when none is shipped/registered.
	 *
	 * Synchronous: the on-disk answer comes from the map {@linkcode warm} preloaded, so no filesystem probe runs per call.
	 */
	readonly for = (country: string): BANShards => {
		const cc = country.toLowerCase()
		const cached = this.#cache.get(cc)

		if (cached) return cached

		const entry: BANShards = {}

		// Only countries with a registered street locale AND an on-disk shard — never key with the wrong rules.
		if (supportedBANCountries().includes(cc)) {
			const locale = streetLocaleForBANCountry(cc)
			const path = this.#shardPath(cc)

			if (this.#onDisk.has(path)) {
				entry.addressPoints = new AddressPointSqliteLookup(path, { streetLocale: locale })
			}

			// The #1042 derived street tier — purely additive, opened only when its artifact is on disk.
			const streetPath = this.#streetCentroidPath(cc)

			if (this.#onDisk.has(streetPath)) {
				entry.streetCentroids = new StreetCentroidSqliteLookup(streetPath, { streetLocale: locale })
			}
		}

		this.#cache.set(cc, entry)

		return entry
	};

	[Symbol.dispose](): void {
		for (const entry of this.#cache.values()) {
			entry.addressPoints?.[Symbol.dispose]()
			entry.streetCentroids?.[Symbol.dispose]()
		}

		this.#cache.clear()
	}
}
