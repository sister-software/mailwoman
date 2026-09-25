/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Regenerates the committed `codex/country/population.ts` table from GeoNames `countryInfo.txt`.
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

const SOURCE = "https://download.geonames.org/export/dump/countryInfo.txt"

/**
 * Resolves the committed table from the `@mailwoman/codex` package root, so the path
 * is the same from the source tree, `out/` and a published tarball.
 */
const DEFAULT_OUT = resolvePackagePath("@mailwoman/codex", "lib", "country", "population.ts")

/**
 * These are the tab positions read from each 19-column `countryInfo.txt` row.
 */
const COLUMN_ISO2 = 0
const COLUMN_POPULATION = 7
const MINIMUM_COLUMNS = 8

/**
 * Sets the fewest parsed countries that count as a valid parse.
 *
 * GeoNames lists about 250 countries and territories, so fewer rows mean a
 * format change or a truncated download.
 */
const MINIMUM_PLAUSIBLE_COUNTRIES = 200

/**
 * Sets the smallest number written with `_` separators, which the house style uses from five digits up.
 */
const SEPARATOR_MINIMUM = 10_000

/**
 * Configures {@linkcode generateCountryPopulation}.
 */
export interface GenerateCountryPopulationOptions {
	/**
	 * Overrides the output path, which defaults to the committed `codex/country/population.ts`.
	 */
	out?: string
}

/**
 * Summarizes a {@linkcode generateCountryPopulation} run.
 */
export interface GenerateCountryPopulationSummary {
	countries: number
	outPath: string
}

/**
 * Fetches GeoNames `countryInfo.txt` and regenerates the committed `COUNTRY_POPULATION` table.
 *
 * The table fills in countries whose WOF record has no population.
 * A country with a GeoNames population of 0 is omitted, so consumers see it as unknown instead of as zero.
 *
 * @throws If fewer than `MINIMUM_PLAUSIBLE_COUNTRIES` rows parse.
 */
export async function generateCountryPopulation(
	options: GenerateCountryPopulationOptions = {},
	report?: (line: string) => void
): Promise<GenerateCountryPopulationSummary> {
	const outPath = options.out ?? DEFAULT_OUT

	const text = await new APIClient({ displayName: "geonames-country-info", retry: true })
		.fetch<string>({ url: SOURCE, responseType: "text" })
		.then(pluckResponseData)

	const rows: Record<string, number> = {}

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- countryInfo.txt is ~35 kB and bounded (~300 rows)
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("#")) continue
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- one 19-column row
		const columns = line.split("\t")

		if (columns.length < MINIMUM_COLUMNS) continue
		const alpha2 = columns[COLUMN_ISO2]!.trim()
		const population = Number(columns[COLUMN_POPULATION])

		if (!/^[A-Z]{2}$/.test(alpha2)) continue

		if (!Number.isFinite(population) || population <= 0) continue

		rows[alpha2] = population
	}

	if (Object.keys(rows).length < MINIMUM_PLAUSIBLE_COUNTRIES) {
		throw new Error(`generateCountryPopulation: only ${Object.keys(rows).length} rows parsed — format drift?`)
	}

	const body = Object.keys(rows)
		.toSorted()
		.map((k) => {
			const n = rows[k]!
			const literal = n >= SEPARATOR_MINIMUM ? n.toLocaleString("en-US").replaceAll(",", "_") : String(n)

			return `\t${k}: ${literal},`
		})
		.join("\n")

	const header = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   generated — do not edit by hand. Per-country population, derived from GeoNames countryInfo.txt
 *   (https://download.geonames.org/export/dump/countryInfo.txt, CC-BY-4.0). Estimates are
 *   census-vintage; a prominence race reads the magnitude, not the currency. Countries GeoNames
 *   declines to estimate are absent, never zero.
 *   Regenerate with: mailwoman dev generate country-population
 */

/**
 * ISO 3166-1 alpha-2 → population estimate.
 */
export const COUNTRY_POPULATION: Readonly<Record<string, number>> = {`

	await writeLocalTextFile(`${header}\n${body}\n}\n`, outPath)
	report?.(`wrote ${outPath} (${Object.keys(rows).length} countries)`)

	return { countries: Object.keys(rows).length, outPath }
}
