/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The OSM rooftop extract provider, the injection point the geocode cascade consults for the opt-in
 *   international precision tier. Given a data root, it opens the extract the caller's active selection
 *   names for a country, else `osm/address-points-<cc>-<cc>.db`, with the country's street-normalization locale. Probe-side keying then matches the extract the
 *   builder wrote. The provider caches the open handle per country. Wire its bound `for` into
 *   `GeocodeDeps.osmExtracts`.
 *
 *   The extracts it opens are OpenStreetMap Derivative Databases under ODbL 1.0, each built locally by the
 *   operator. `README.md` states the licensing boundary. A caller that applies a license policy passes
 *   `admit`, which sees each extract's manifest before the provider attaches it and throws to refuse it.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readLayerManifest, type LayerManifest, type layerschemadatabase } from "@mailwoman/core/layers"
import type { RegionDatabaseProvider, RegionDatabases } from "@mailwoman/core/resolver"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"

import { osmDatabaseRoot } from "#paths"
import { streetLocaleForCountry, supportedOSMCountries } from "#street-locale"

/**
 * The member of {@link RegionDatabases} an OSM extract supplies, narrowed to the
 * SQLite class that opened it so the provider can dispose the handle.
 */
export interface OSMExtracts extends Pick<RegionDatabases, "addressPoints"> {
	addressPoints?: AddressPointSqliteLookup
}

/**
 * Inspects an extract's manifest before the provider attaches it, and throws to refuse the extract.
 *
 * The error propagates out of {@linkcode OSMRegionDatabaseProvider.create}, so a refused
 * extract stops the session that would have read it rather than being skipped.
 * A skipped extract would make its country read as having no OpenStreetMap data.
 */
export type OSMExtractAdmission = (manifest: LayerManifest, path: string) => void

/**
 * Options for {@linkcode OSMRegionDatabaseProvider.create}.
 */
export interface OSMRegionDatabaseProviderOptions {
	admit?: OSMExtractAdmission
	/**
	 * Lowercase alpha-2 country to the extract path an installation selected for it.
	 *
	 * A country listed here reads that file in place of its conventional
	 * `address-points-<cc>-<cc>.db`, and every other country reads the conventional path.
	 * The caller reads the selection, because the selection's records belong to
	 * the package that installs data.
	 */
	selected?: ReadonlyMap<string, string>
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
	readonly #admit: OSMExtractAdmission | undefined
	readonly #selected: ReadonlyMap<string, string>
	#warmPromise?: Promise<void>

	constructor(dataRoot: PathBuilder, options: OSMRegionDatabaseProviderOptions = {}) {
		this.#dataRoot = dataRoot
		this.#admit = options.admit
		this.#selected = options.selected ?? new Map()
	}

	/**
	 * Construct a provider and warm its existence map before answering.
	 *
	 * A caller that constructs directly must {@linkcode warm} before the first `for`.
	 *
	 * @throws The error `options.admit` throws for an extract it refuses.
	 */
	static async create(
		dataRoot: PathBuilder,
		options: OSMRegionDatabaseProviderOptions = {}
	): Promise<OSMRegionDatabaseProvider> {
		const provider = new OSMRegionDatabaseProvider(dataRoot, options)

		await provider.warm()

		return provider
	}

	#addressPointsPath(countryCode: string): string {
		return (
			this.#selected.get(countryCode) ??
			osmDatabaseRoot(this.#dataRoot)(`address-points-${countryCode}-${countryCode}.db`).toString()
		)
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
			const path = this.#addressPointsPath(cc)

			if (!(await pathExists(path))) continue

			if (this.#admit) {
				using db = new DatabaseClient<layerschemadatabase>(path, { readOnly: true })

				this.#admit(await readLayerManifest(db), path)
			}

			this.#onDisk.add(path)
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
			const path = this.#addressPointsPath(cc)

			if (this.#onDisk.has(path)) {
				// The rooftop builder stores `addr:suburb` before `addr:city`, so a stored locality can be part of a place.
				entry = {
					addressPoints: new AddressPointSqliteLookup(path, {
						streetLocale: streetLocaleForCountry(cc),
						localityLevel: "finest",
					}),
				}
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
