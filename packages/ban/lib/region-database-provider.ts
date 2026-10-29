/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The BAN rooftop extract provider the geocode cascade consults for the national open-register
 *   precision tier, ahead of the community OSM tier. The registry is deliberately FR-only today.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { RegionDatabaseProvider, RegionDatabases } from "@mailwoman/core/resolver"
import { AddressPointSqliteLookup, StreetCentroidSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import type { PathBuilder } from "path-ts"

import { banDatabaseRoot } from "#paths"
import { streetLocaleForBANCountry, supportedBANCountries } from "#street-locale"

/**
 * The members of {@link RegionDatabases} a BAN extract supplies, each narrowed to the
 * SQLite class that opened it so the provider can dispose the handle.
 */
export interface BANExtracts extends Pick<RegionDatabases, "addressPoints" | "streetCentroids"> {
	addressPoints?: AddressPointSqliteLookup
	/**
	 * The derived street-centroid tier, a `group BY street` roll-up for a street-only query.
	 */
	streetCentroids?: StreetCentroidSqliteLookup
}

/**
 * Opens and caches BAN rooftop lookups per country.
 * Call `warm` before the first `for`.
 */
/**
 * Extract paths chosen outside the provider, such as by an installation's active
 * selection, keyed by lowercase country code.
 *
 * A country listed here reads that file in place of its conventional path.
 */
export interface BANSelectedPaths {
	addressPoints?: ReadonlyMap<string, string>
	streetCentroids?: ReadonlyMap<string, string>
}

export class BANRegionDatabaseProvider implements RegionDatabaseProvider<string, BANExtracts> {
	readonly #dataRoot: PathBuilder
	readonly #selected: BANSelectedPaths
	readonly #cache = new Map<string, BANExtracts>()
	/**
	 * Extract paths {@linkcode warm} observed on disk, the synchronous existence source `for` consults.
	 */
	readonly #onDisk = new Set<string>()
	#warmPromise?: Promise<void>

	constructor(dataRoot: PathBuilder, selected: BANSelectedPaths = {}) {
		this.#dataRoot = dataRoot
		this.#selected = selected
	}

	/**
	 * Construct a provider and warm its existence map before answering.
	 *
	 * @param selected Paths chosen for some countries, read in place of their conventional paths.
	 */
	static async create(dataRoot: PathBuilder, selected: BANSelectedPaths = {}): Promise<BANRegionDatabaseProvider> {
		const provider = new BANRegionDatabaseProvider(dataRoot, selected)

		await provider.warm()

		return provider
	}

	#addressPointsPath(countryCode: string): PathBuilder | string {
		return (
			this.#selected.addressPoints?.get(countryCode) ??
			banDatabaseRoot(this.#dataRoot)(`address-points-${countryCode}.db`)
		)
	}

	#streetCentroidPath(countryCode: string): PathBuilder | string {
		return (
			this.#selected.streetCentroids?.get(countryCode) ??
			banDatabaseRoot(this.#dataRoot)(`street-centroids-${countryCode}.db`)
		)
	}

	/**
	 * Preload extract existence for every country the provider may be asked for,
	 * caching the probe so every caller shares one pass.
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
	 * Resolve the BAN extracts for an ISO-3166 alpha-2 country from the map {@linkcode warm}
	 * preloaded, answering `{}` when none is registered.
	 */
	readonly for = (country: string): BANExtracts => {
		const cc = country.toLowerCase()
		const cached = this.#cache.get(cc)

		if (cached) return cached

		const entry: BANExtracts = {}

		// Street-key generation requires a registered street locale and an on-disk extract.
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
