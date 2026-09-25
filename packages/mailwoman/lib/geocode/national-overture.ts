/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import { addressPointDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { createStreetLocaleRegistry, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street"
import type { PathBuilderLike } from "path-ts"

import type { RegionDatabases } from "#geocode/regions"

const COUNTRY_TO_STREET_LOCALE = new Map<string, StreetLocale>([
	["tw", "zh"],
	["it", "it"],
])

const registry = createStreetLocaleRegistry(
	COUNTRY_TO_STREET_LOCALE,
	"Add it to COUNTRY_TO_STREET_LOCALE in national-overture.ts, with the matching branch in normalizeStreetForKeyLocale, before building its national address-point database."
)

/**
 * Returns the street-normalization locale used to key a country's national address-point database.
 *
 * @throws When the country has no registered locale, since its street keys would not match at lookup time.
 */
export function streetLocaleForOvertureCountry(countryCode: string): StreetLocale {
	return registry.localeFor(countryCode)
}

/**
 * The SPDX expression each country's national address-point database is published under:
 * Overture's theme license, and the upstream register's own.
 *
 * The second half rests on research into the publisher's terms rather than on the file,
 * because `sources[].license` reads NULL for every row of every country here.
 * `sources[].dataset` is what identifies the publisher that research has to be about.
 *
 * The first half is `CDLA-Permissive-2.0` because Overture licenses its themes separately
 * and the addresses theme is composed from permissively licensed sources.
 * ODbL reaches the OSM-derived themes, divisions and transportation,
 * so it does not belong on a row from this one.
 */
const COUNTRY_TO_LICENSE = new Map<string, string>([
	// `OpenAddresses/<bureau> Civil Affairs`, the fifteen bureaus.
	["tw", "CDLA-Permissive-2.0 AND OGDL-Taiwan-1.0"],
	// `OpenAddresses/Istat e dall'Agenzia delle Entrate`, which is ANNCSU.
	// CC-BY-4.0 is the term #2300 records, awaiting the per-source terms evidence
	// the counsel tranche collects.
	["it", "CDLA-Permissive-2.0 AND CC-BY-4.0"],
])

/**
 * Returns the SPDX license expression that a country's national address-point database is published under.
 *
 * @throws When the country has no registered license.
 */
export function licenseForOvertureCountry(countryCode: string): string {
	const license = COUNTRY_TO_LICENSE.get(countryCode.toLowerCase())

	if (!license) {
		throw new Error(
			`No license expression registered for country "${countryCode}". Add it to COUNTRY_TO_LICENSE in national-overture.ts.`
		)
	}

	return license
}

/**
 * Lists the lowercase country codes that have a registered national Overture address-point locale.
 */
export function supportedOvertureCountries(): string[] {
	return registry.supported()
}

/**
 * Returns the path of a country's national address-point database, in the same
 * directory `selectAddressPointsDB` reads.
 *
 * The provider treats a missing file as no rooftop tier, so a path anywhere
 * else would hide an existing database.
 */
export function nationalAddressPointsPath(dataRoot: PathBuilderLike, countryCode: string): string {
	return addressPointDatabaseRoot(dataRoot)(`address-points-${countryCode.toLowerCase()}.db`).toString()
}

/**
 * Opens and caches national Overture rooftop lookups by country.
 *
 * Use {@link OvertureNationalDatabaseProvider.create}, because `for` answers
 * only from what `warm` found on disk.
 */
export class OvertureNationalDatabaseProvider implements Disposable {
	readonly #dataRoot: PathBuilderLike
	readonly #cache = new Map<string, RegionDatabases>()
	readonly #onDisk = new Set<string>()
	#warmPromise?: Promise<void>

	constructor(dataRoot: PathBuilderLike) {
		this.#dataRoot = dataRoot
	}

	static async create(dataRoot: PathBuilderLike): Promise<OvertureNationalDatabaseProvider> {
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
	 * Returns the rooftop lookup for an ISO 3166-1 alpha-2 country, or `{}`
	 * when the country is unsupported or its database is not on disk.
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
