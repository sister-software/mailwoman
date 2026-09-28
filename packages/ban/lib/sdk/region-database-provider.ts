/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The BAN rooftop extract provider the geocode cascade consults for the national open-register
 *   precision tier, ahead of the community OSM tier. The registry is deliberately FR-only today.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { RegionDatabaseProvider, RegionDatabases } from "@mailwoman/core/resolver"
import { AddressPointSqliteLookup, StreetCentroidSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import type { PathBuilder } from "path-ts"

import { banDatabaseRoot } from "#paths"
import { streetLocaleForBANCountry, supportedBANCountries } from "#sdk/street-locale"

/**
 * The members of {@link RegionDatabases} a BAN extract supplies, each narrowed to the SQLite class
 * that opened it so the provider can dispose the handle.
 */
export interface BANExtracts extends Pick<RegionDatabases, "addressPoints" | "streetCentroids"> {
	addressPoints?: AddressPointSqliteLookup
	/**
	 * The derived street-centroid tier, a `group BY street` roll-up for a street-only query.
	 */
	streetCentroids?: StreetCentroidSqliteLookup
}

/**
 * Opens and caches per-country BAN rooftop lookups, which must be warmed before the first `for`.
 */
export class BANRegionDatabaseProvider implements RegionDatabaseProvider<string, BANExtracts> {
	readonly #dataRoot: PathBuilder
	readonly #cache = new Map<string, BANExtracts>()
	/**
	 * Extract paths {@linkcode warm} observed on disk, the synchronous existence source `for` consults.
	 */
	readonly #onDisk = new Set<string>()
	#warmPromise?: Promise<void>

	constructor(dataRoot: PathBuilder) {
		this.#dataRoot = dataRoot
	}

	/**
	 * Construct a provider and warm its existence map before answering.
	 */
	static async create(dataRoot: PathBuilder): Promise<BANRegionDatabaseProvider> {
		const provider = new BANRegionDatabaseProvider(dataRoot)

		await provider.warm()

		return provider
	}

	#addressPointsPath(countryCode: string): PathBuilder {
		return banDatabaseRoot(this.#dataRoot)(`address-points-${countryCode}.db`)
	}

	#streetCentroidPath(countryCode: string): PathBuilder {
		return banDatabaseRoot(this.#dataRoot)(`street-centroids-${countryCode}.db`)
	}

	/**
	 * Preload extract existence for every country the provider may be asked for, caching the probe
	 * so every caller shares one pass.
	 */
	readonly warm = (): Promise<void> => (this.#warmPromise ??= this.#probeExtracts())

	async #probeExtracts(): Promise<void> {
		for (const cc of supportedBANCountries()) {
			for (const path of [this.#addressPointsPath(cc), this.#streetCentroidPath(cc)]) {
				if (await pathExists(path)) {
					this.#onDisk.add(path.toString())
				}
			}
		}
	}

	/**
	 * Resolve the BAN extracts for an ISO-3166 alpha-2 country from the map {@linkcode warm} preloaded,
	 * answering `{}` when none is registered.
	 */
	readonly for = (country: string): BANExtracts => {
		const cc = country.toLowerCase()
		const cached = this.#cache.get(cc)

		if (cached) return cached

		const entry: BANExtracts = {}

		// Keying requires a registered street locale and an on-disk extract.
		if (supportedBANCountries().includes(cc)) {
			const locale = streetLocaleForBANCountry(cc)
			const path = this.#addressPointsPath(cc).toString()

			if (this.#onDisk.has(path)) {
				entry.addressPoints = new AddressPointSqliteLookup(path, { streetLocale: locale })
			}

			// The derived street tier is additive and opens only when its artifact is on disk.
			const streetPath = this.#streetCentroidPath(cc).toString()

			if (this.#onDisk.has(streetPath)) {
				entry.streetCentroids = new StreetCentroidSqliteLookup(streetPath, { streetLocale: locale })
			}
		}

		this.#cache.set(cc, entry)

		return entry
	}

	public [Symbol.dispose](): void {
		for (const entry of this.#cache.values()) {
			entry.addressPoints?.[Symbol.dispose]()
			entry.streetCentroids?.[Symbol.dispose]()
		}

		this.#cache.clear()
	}
}
