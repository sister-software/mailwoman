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
	// ANNCSU writes the street type out in front of the name, and the `it` rule
	// expands an abbreviated type and keeps it.
	// See `normalizeStreetForKeyLocale` for why it is kept rather than dropped: over the
	// 2026-05-20.0 release, dropping it merges 4.375% of Italy's distinct (comune, street) pairs.
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
 * Neither half comes from the parquet.
 * Measured over the 2026-05-20.0 and 2026-06-17.0 releases, the `sources[].license` field reads
 * NULL for every row of every country here, Taiwan included, so the second half of each expression
 * rests on research into the publisher's own terms rather than on anything the file states.
 *
 * What the file does supply is `sources[].dataset`, which identifies the
 * publisher the research has to be about.
 *
 * The first half is `CDLA-Permissive-2.0` because Overture licenses its themes separately
 * and the addresses theme is composed from permissively licensed sources.
 * Do not carry ODbL onto a row from this theme: that obligation reaches the
 * OSM-derived themes, divisions and transportation.
 */
const COUNTRY_TO_LICENSE = new Map<string, string>([
	// `sources[].dataset` reads `OpenAddresses/<bureau> Civil Affairs` across the fifteen bureaus.
	["tw", "CDLA-Permissive-2.0 AND OGDL-Taiwan-1.0"],
	// `sources[].dataset` reads `OpenAddresses/Istat e dall'Agenzia delle Entrate` on all 25,914,431 rows,
	// which is ANNCSU, the national street and house-number register those two agencies publish jointly.
	// CC-BY-4.0 is the term recorded for it in #2300 and it carries the same standing as
	// Taiwan's OGDL entry: a reading of the publisher's terms, awaiting the immutable
	// terms evidence that the counsel tranche collects per source.
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
