/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { RegionDatabaseProvider, RegionDatabases } from "@mailwoman/core/resolver"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite"
import { addressPointDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { createStreetLocaleRegistry, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street"
import type { PathBuilderLike } from "path-ts"

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
 * What is known about the grant on one country's national address-point rows.
 *
 * Two documents can describe the same rows and disagree.
 * Recording the stricter of them states a grant nobody established, and a stricter
 * incorrect attribution is as incorrect as a permissive one.
 *
 * So an entry holds either a settled expression or the candidate readings
 * and the evidence for each, and the build refuses to stamp an unsettled one.
 */
export interface OvertureCountryLicense {
	/**
	 * The SPDX expression, where one document settles it.
	 */
	expression?: string
	/**
	 * The readings that remain, where more than one document describes the rows.
	 */
	candidates?: readonly string[]
	/**
	 * What each reading rests on, so a later reader does not repeat the research.
	 */
	evidence: readonly string[]
	/**
	 * The register `sources[].dataset` records, which is what any research has to be about.
	 */
	register: string
}

/**
 * The grant on each country's national address-point database, which is the upstream register's alone.
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
const COUNTRY_LICENSES = new Map<string, OvertureCountryLicense>([
	[
		"tw",
		{
			// Two documents describe the same municipal 門牌 rows and name different grants.
			// Overture's attribution page gives CC-BY-4.0 for each of the 18 Civil Affairs bodies.
			// The counsel dossier reads OGDL-Taiwan-1.0, whose attribution failure voids the
			// grant ab initio and whose §5.2 permits an agency to withdraw data.
			// Recording either one asserts a reading nobody has made.
			candidates: ["CC-BY-4.0", "OGDL-Taiwan-1.0"],
			evidence: [
				"Overture attribution page, Taiwan section, read 2026-09-25: CC BY 4.0 on all 18 entries",
				"docs/superpowers/plans/counsel-dossier.md §6: OGDL-Taiwan-1.0 over the municipal 門牌 data",
			],
			register: "OpenAddresses/<bureau> Civil Affairs",
		},
	],
	[
		"it",
		{
			expression: "CC-BY-4.0",
			evidence: ["Overture attribution page, Italy entry: ANNCSU under CC BY 4.0"],
			register: "OpenAddresses/Istat e dall'Agenzia delle Entrate",
		},
	],
	[
		"es",
		{
			expression: "CC-BY-4.0",
			// CartoCiudad, an IGN/CNIG product within the Sistema Cartográfico Nacional.
			// Attribution reads `CartoCiudad CC-BY 4.0 scne.es`.
			evidence: [
				"Overture attribution page, Spain entry: scne.es under CC BY 4.0",
				"IGN license PDF, which the CNIG product page and Overture both link",
			],
			register: "OpenAddresses/scne.es",
		},
	],
])

/**
 * Returns what is known about a country's grant, or `undefined` for a country with no entry.
 *
 * A caller that needs to reason about an unsettled grant reads this.
 * A caller that needs an expression to record uses {@link licenseForOvertureCountry},
 * which refuses one that is unsettled.
 */
export function overtureCountryLicense(countryCode: string): OvertureCountryLicense | undefined {
	return COUNTRY_LICENSES.get(countryCode.toLowerCase())
}

/**
 * Returns the SPDX license expression a country's national address-point database is published under.
 *
 * @throws When the country has no entry, or when its entry holds candidate readings
 * rather than a settled expression.
 * A build that stamped a candidate would record a grant nobody established,
 * and the artifact would carry that claim for as long as it exists.
 */
export function licenseForOvertureCountry(countryCode: string): string {
	const entry = overtureCountryLicense(countryCode)

	if (!entry) {
		throw new Error(
			`No license registered for country "${countryCode}". Add it to COUNTRY_LICENSES in national-overture.ts.`
		)
	}

	if (!entry.expression) {
		const candidates = entry.candidates?.join(" or ") ?? "none recorded"

		throw new Error(
			`The grant on ${countryCode}'s ${entry.register} rows is unsettled: ${candidates}. ` +
				`Evidence: ${entry.evidence.join("; ")}. ` +
				`Stamping either candidate would record a grant nobody established, so this build stops. ` +
				`Settle it and give the entry an \`expression\` in COUNTRY_LICENSES.`
		)
	}

	return entry.expression
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
export class OvertureNationalDatabaseProvider implements RegionDatabaseProvider<string, RegionDatabases> {
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
