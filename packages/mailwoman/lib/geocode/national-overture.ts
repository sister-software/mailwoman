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
	["es", "es"],
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
 * The SPDX expression each country's national address-point database is published under,
 * which is the upstream register's license alone.
 *
 * Overture declares no identifier for the addresses theme.
 * Its attribution page gives every other theme one, `CDLA-Permissive-2.0` for places
 * and `ODbL-1.0` for divisions, and for addresses states only that the sources carry
 * permissive open licenses before listing the upstream register per country.
 *
 * An expression carrying a second Overture grant would assert a grant Overture does not make.
 *
 * `sources[].license` reads NULL on every row of every country here, so the identifier
 * comes from Overture's entry for the register that `sources[].dataset` records.
 */
const COUNTRY_TO_LICENSE = new Map<string, string>([
	// `OpenAddresses/<bureau> Civil Affairs`, the county and city bodies Overture lists under Taiwan.
	// Overture states CC-BY-4.0 for each one.
	// `docs/superpowers/plans/counsel-dossier.md` reads the same municipal 門牌 rows as
	// OGDL-Taiwan-1.0, whose attribution failure voids the grant.
	// This records the stricter of the two readings.
	["tw", "OGDL-Taiwan-1.0"],
	// `OpenAddresses/Istat e dall'Agenzia delle Entrate`, which Overture lists as ANNCSU.
	["it", "CC-BY-4.0"],
	// `OpenAddresses/scne.es`, which Overture lists as `scne.es`: CartoCiudad,
	// an IGN/CNIG product within the Sistema Cartográfico Nacional.
	// Attribution reads `CartoCiudad CC-BY 4.0 scne.es`.
	["es", "CC-BY-4.0"],
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
