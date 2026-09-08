/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The national Overture rooftop tier: one address-point database per country, built by
 *   `mailwoman situs address-points --country <cc>` from that country's Overture addresses parquet and read here with
 *   the street locale the build keyed it under. Taiwan is the first member: the civil-affairs registers Overture
 *   carries for 15 of its 22 縣市 answer a rooftop for a `縣市 鄉鎮市區 street number` line that the admin ladder could only
 *   place at the 鄉鎮市區 centroid, or the 縣市's when the district is absent from the gazetteer.
 *
 *   The US is NOT a member: its Overture rows are keyed per state and served by `RegionDatabaseProvider`. The provider
 *   has the same `for(country)` shape as the BAN and OSM providers so the geocode session composes it beside them, and it
 *   is a no-op for a country with no registered locale or no database on disk.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import { createStreetLocaleRegistry, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street"
import { join } from "path-ts"

import type { RegionDatabases } from "#geocode/regions"

/**
 * Country → the street locale its national Overture extract is BUILT and PROBED with. Membership is a per-register
 * decision: a country joins when its parquet has been read (which fields scope a point, how the number is written) and
 * a locale branch keys those surfaces on both sides.
 */
const COUNTRY_TO_STREET_LOCALE = new Map<string, StreetLocale>([
	// The Taiwanese civil-affairs registers: 縣市 + 鄉鎮市區 scope the point, no postcode, full-width digits and a
	// trailing 號 on the number, kanji road-section numerals (`一段`).
	["tw", "zh"],
])

const registry = createStreetLocaleRegistry(
	COUNTRY_TO_STREET_LOCALE,
	"Add it to COUNTRY_TO_STREET_LOCALE in national-overture.ts, with the matching branch in normalizeStreetForKeyLocale, before building its national address-point database."
)

export function streetLocaleForOvertureCountry(countryCode: string): StreetLocale {
	return registry.localeFor(countryCode)
}

/**
 * The SPDX expression a country's national database records in its layer manifest: Overture's theme license AND the
 * source registers' own. The per-agency attribution is computed by the build from the rows it kept and stamped beside
 * it.
 */
const COUNTRY_TO_LICENSE = new Map<string, string>([
	// The fifteen civil-affairs bureaus publish under the Open Government Data License, Taiwan, v1.0.
	["tw", "CDLA-Permissive-2.0 AND OGDL-Taiwan-1.0"],
])

export function licenseForOvertureCountry(countryCode: string): string {
	const license = COUNTRY_TO_LICENSE.get(countryCode.toLowerCase())

	if (!license) {
		throw new Error(
			`No license expression registered for country "${countryCode}". Add it to COUNTRY_TO_LICENSE in national-overture.ts.`
		)
	}

	return license
}

export function supportedOvertureCountries(): string[] {
	return registry.supported()
}

/**
 * Where a country's national address-point database lives: beside the US per-state databases, since both are Overture
 * addresses keyed by the shared schema.
 */
export function nationalAddressPointsPath(dataRoot: string, countryCode: string): string {
	return join(dataRoot, "address-points", `address-points-${countryCode.toLowerCase()}.db`)
}

/**
 * Opens and caches the national Overture rooftop lookups by country. `warm` probes the disk once for every registered
 * country so `for` never touches the filesystem; prefer {@link OvertureNationalDatabaseProvider.create}, which warms
 * before answering.
 */
export class OvertureNationalDatabaseProvider implements Disposable {
	readonly #dataRoot: string
	readonly #cache = new Map<string, RegionDatabases>()
	readonly #onDisk = new Set<string>()
	#warmPromise?: Promise<void>

	constructor(dataRoot: string) {
		this.#dataRoot = dataRoot
	}

	static async create(dataRoot: string): Promise<OvertureNationalDatabaseProvider> {
		const provider = new OvertureNationalDatabaseProvider(dataRoot)

		await provider.warm()

		return provider
	}

	readonly warm = (): Promise<void> => (this.#warmPromise ??= this.#probe())

	async #probe(): Promise<void> {
		for (const cc of supportedOvertureCountries()) {
			const path = nationalAddressPointsPath(this.#dataRoot, cc)

			if (await pathExists(path)) {
				this.#onDisk.add(path)
			}
		}
	}

	/**
	 * The rooftop lookup for an ISO-3166 alpha-2 country, or `{}` when the country has no registered locale or no
	 * database on disk.
	 */
	readonly for = (country: string): RegionDatabases => {
		const cc = country.toLowerCase()
		const cached = this.#cache.get(cc)

		if (cached) return cached

		const entry: RegionDatabases = {}

		if (supportedOvertureCountries().includes(cc)) {
			const path = nationalAddressPointsPath(this.#dataRoot, cc)

			if (this.#onDisk.has(path)) {
				entry.addressPoints = new AddressPointSqliteLookup(path, { streetLocale: streetLocaleForOvertureCountry(cc) })
			}
		}

		this.#cache.set(cc, entry)

		return entry
	};

	[Symbol.dispose](): void {
		for (const entry of this.#cache.values()) {
			;(entry.addressPoints as Disposable | undefined)?.[Symbol.dispose]()
		}

		this.#cache.clear()
	}
}
