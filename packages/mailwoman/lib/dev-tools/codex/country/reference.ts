/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Regenerates the committed calling-code and currency table in `codex/country/reference-data.ts`.
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

const SOURCE = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"

/**
 * Resolves the committed table from the `@mailwoman/codex` package root, so the path
 * is the same from the source tree, `out/` and a published tarball.
 */
const DEFAULT_OUT = resolvePackagePath("@mailwoman/codex", "lib", "country", "reference-data.ts")

/**
 * Describes the fields this tool reads from one mledoze/countries record.
 */
interface MledozeCountry {
	cca2?: string
	idd?: { root?: string; suffixes?: string[] }
	currencies?: Record<string, { name?: string; symbol?: string }>
}

/**
 * Describes one emitted row of the reference table.
 */
interface CountryReferenceEntry {
	callingCode?: number
	currency?: { isoCode: string; name?: string; symbol?: string }
}

/**
 * Configures {@linkcode generateCountryReference}.
 */
export interface GenerateCountryReferenceOptions {
	/**
	 * Overrides the output path, which defaults to the committed `codex/country/reference-data.ts`.
	 */
	out?: string
}

/**
 * Summarizes a {@linkcode generateCountryReference} run.
 */
export interface GenerateCountryReferenceSummary {
	countries: number
	outPath: string
}

/**
 * Joins mledoze's `idd.root` and `idd.suffixes` into an E.164 calling code.
 *
 * A single suffix completes the code, so GB's `+4` and `4` give 44.
 * NANP members share root `+1` and list area codes as suffixes, so they map to 1.
 */
function callingCode(country: MledozeCountry): number | undefined {
	const root = (country.idd?.root ?? "").replace("+", "")
	const suffixes = country.idd?.suffixes ?? []

	if (!root) return undefined

	if (root === "1") return 1

	if (suffixes.length === 1) {
		const n = Number(root + suffixes[0])

		return Number.isFinite(n) ? n : undefined
	}

	const n = Number(root)

	return Number.isFinite(n) ? n : undefined
}

const serialize = (o: CountryReferenceEntry): string =>
	prettyJSON(o)
		.replaceAll('"isoCode"', "isoCode")
		.replaceAll('"callingCode"', "callingCode")
		.replaceAll('"currency"', "currency")
		.replaceAll('"name"', "name")
		.replaceAll('"symbol"', "symbol")

/**
 * Fetches mledoze/countries and regenerates the committed `COUNTRY_REFERENCE` table.
 */
export async function generateCountryReference(
	options: GenerateCountryReferenceOptions = {},
	report?: (line: string) => void
): Promise<GenerateCountryReferenceSummary> {
	const outPath = options.out ?? DEFAULT_OUT

	const countries = await new APIClient({ displayName: "mledoze-countries", retry: true })
		.fetch<MledozeCountry[]>({ url: SOURCE })
		.then(pluckResponseData)

	const rows: Record<string, CountryReferenceEntry> = {}

	for (const country of countries) {
		const alpha2 = country.cca2

		if (!alpha2) continue
		const entry: CountryReferenceEntry = {}
		const cc = callingCode(country)

		if (cc != null) {
			entry.callingCode = cc
		}

		const currencyCodes = Object.keys(country.currencies ?? {}).toSorted()

		if (currencyCodes.length) {
			const code = currencyCodes[0]!
			const info = country.currencies![code] ?? {}
			entry.currency = { isoCode: code }

			if (info.name) {
				entry.currency.name = info.name
			}

			if (info.symbol) {
				entry.currency.symbol = info.symbol
			}
		}

		if (Object.keys(entry).length) {
			rows[alpha2] = entry
		}
	}

	const body = Object.keys(rows)
		.toSorted()
		.map((k) => `\t${k}: ${serialize(rows[k]!)},`)
		.join("\n")

	const header = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   generated — do not edit by hand. Country calling codes (E.164) + currencies (ISO 4217), derived
 *   from mledoze/countries (https://github.com/mledoze/countries, ODbL). nanp members map to 1.
 *   Regenerate with: mailwoman dev generate country-reference
 */

/** Static per-country reference: calling code + currency. */
export interface CountryReference {
	callingCode?: number
	currency?: { isoCode: string; name?: string; symbol?: string }
}

/** ISO 3166-1 alpha-2 → reference. */
export const COUNTRY_REFERENCE: Record<string, CountryReference> = {`

	await writeLocalTextFile(`${header}\n${body}\n}\n`, outPath)
	report?.(`wrote ${outPath} (${Object.keys(rows).length} countries)`)

	return { countries: Object.keys(rows).length, outPath }
}
