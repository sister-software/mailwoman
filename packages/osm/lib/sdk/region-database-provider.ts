/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The OSM rooftop extract provider, the injection point the geocode cascade consults for the opt-in
 *   international precision tier. Given a data root, it opens `osm/address-points-<cc>-<cc>.db`
 *   with the country's street-normalization locale. Probe-side keying then matches the extract the
 *   builder wrote. The provider caches the open handle per country. Wire its bound `for` into
 *   `GeocodeDeps.osmExtracts`.
 *
 *   ⚠ The extracts it opens are ODbL OpenStreetMap Derived Databases. See `osm/readme.md` for the
 *   distribution boundary and the counsel sign-off required before shipping any of them.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { RegionDatabaseProvider, RegionDatabases } from "@mailwoman/core/resolver"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import type { PathBuilder } from "path-ts"

import { osmDatabaseRoot } from "#paths"
import { streetLocaleForCountry, supportedOSMCountries } from "#sdk/street/locale"

/**
 * The member of {@link RegionDatabases} an OSM extract supplies, narrowed to the
 * SQLite class that opened it so the provider can dispose the handle.
 */
export interface OSMExtracts extends Pick<RegionDatabases, "addressPoints"> {
	addressPoints?: AddressPointSqliteLookup
}

/**
 * Opens and caches per-country OSM rooftop lookups.
 *
 * `for` is synchronous, so on-disk existence is probed asynchronously once instead of per
 * call. {@linkcode warm} awaits `pathExists` for every supported country's extract.
 * It records existing extracts.
 *
 * `for` consults that record.
 * Prefer {@linkcode OSMRegionDatabaseProvider.create}.
 * It constructs the provider and warms it before answering.
 *
 * A provider constructed directly must be warmed before its first `for`,
 * or it answers `{}` for every country.
 */
export class OSMRegionDatabaseProvider implements RegionDatabaseProvider<string, OSMExtracts> {
	readonly #dataRoot: PathBuilder
	readonly #cache = new Map<string, OSMExtracts>()
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
	 *
	 * A caller that constructs directly must {@linkcode warm} before the first `for`.
	 */
	static async create(dataRoot: PathBuilder): Promise<OSMRegionDatabaseProvider> {
		const provider = new OSMRegionDatabaseProvider(dataRoot)

		await provider.warm()

		return provider
	}

	#addressPointsPath(countryCode: string): PathBuilder {
		return osmDatabaseRoot(this.#dataRoot)(`address-points-${countryCode}-${countryCode}.db`)
	}

	/**
	 * Preload extract existence for every country the provider may be asked for.
	 *
	 * Safe to call more than once: the probe promise is cached, so every caller
	 * (and {@linkcode OSMRegionDatabaseProvider.create}) shares one pass.
	 */
	readonly warm = (): Promise<void> => (this.#warmPromise ??= this.#probeExtracts())

	async #probeExtracts(): Promise<void> {
		for (const cc of supportedOSMCountries()) {
			const path = this.#addressPointsPath(cc).toString()

			if (await pathExists(path)) {
				this.#onDisk.add(path)
			}
		}
	}

	/**
	 * Resolve the OSM extracts for an ISO-3166 alpha-2 country, or `{}` when none is shipped/registered.
	 *
	 * Synchronous: the on-disk answer comes from the map {@linkcode warm} preloaded,
	 * so no filesystem probe runs per call.
	 */
	readonly for = (country: string): OSMExtracts => {
		const cc = country.toLowerCase()
		const cached = this.#cache.get(cc)

		if (cached) return cached

		let entry: OSMExtracts = {}

		// Only countries with a registered street locale and an on-disk extract, never key with the wrong rules.
		if (supportedOSMCountries().includes(cc)) {
			const path = this.#addressPointsPath(cc).toString()

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
