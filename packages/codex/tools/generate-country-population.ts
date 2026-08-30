/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerate `codex/country/population.ts` — the per-country population table — from GeoNames
 *   `countryInfo.txt` (https://download.geonames.org/export/dump/countryInfo.txt, CC-BY-4.0). The
 *   output is committed; this tool makes it reproducible (provenance), not a hand-typed dictionary.
 *
 *   Why it exists (#1650): WOF carries no readable population for 147 of 237 country records
 *   (measured against the 2026-08-18 candidate build), so those countries entered every prominence
 *   race at an asserted ZERO — ranked below any namesake hamlet. The magnitude is what a fame race
 *   reads, so a census-vintage figure is entirely sufficient; currency of the estimate is not the
 *   point.
 *
 *   Rows whose GeoNames population is 0 are DROPPED rather than emitted: an entry in this table is a
 *   positive claim, and the consumer's absence branch (`?? undefined`) must stay reachable for
 *   territories GeoNames itself declines to estimate (the meaning-of-zero rule).
 *
 *   Usage: mailwoman dev generate country-population
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { fileURLToPath } from "@mailwoman/platform/url"

const SOURCE = "https://download.geonames.org/export/dump/countryInfo.txt"

/**
 * The committed output path, resolved relative to this module (codex/tools/ → codex/country/). See
 * `generate-country-reference.ts` for why this is `import.meta.url` rather than a `core` path helper (codex is
 * zero-runtime-dep and `core` already references `codex` — importing core here would cycle the project graph).
 */
const DEFAULT_OUT = fileURLToPath(new URL("../country/population.ts", import.meta.url))

/**
 * Tab positions this tool reads from `countryInfo.txt`'s 19-column rows. Named so the parse states which columns it
 * believes in; a GeoNames format change fails the count guard below rather than silently reading the wrong column.
 */
const COLUMN_ISO2 = 0
const COLUMN_POPULATION = 7
const MINIMUM_COLUMNS = 8

/**
 * GeoNames publishes ~250 countries/territories; a parse recovering fewer than this read the wrong column or a
 * truncated body, and the guard fails loudly instead of committing a hollow table.
 */
const MINIMUM_PLAUSIBLE_COUNTRIES = 200

/**
 * Numbers below five digits are emitted bare — the house numeric-separator style groups by three and only from five
 * digits up (`8450`, not `8_450`).
 */
const SEPARATOR_MINIMUM = 10_000

/**
 * Options for {@linkcode generateCountryPopulation}.
 */
export interface GenerateCountryPopulationOptions {
	/**
	 * Output path override. Default: `codex/country/population.ts` (the committed table).
	 */
	out?: string
}

/**
 * Summary returned by {@linkcode generateCountryPopulation}.
 */
export interface GenerateCountryPopulationSummary {
	countries: number
	outPath: string
}

/**
 * Fetch GeoNames `countryInfo.txt` and regenerate the committed `COUNTRY_POPULATION` table.
 */
export async function generateCountryPopulation(
	options: GenerateCountryPopulationOptions = {},
	report?: (line: string) => void
): Promise<GenerateCountryPopulationSummary> {
	const outPath = options.out ?? DEFAULT_OUT

	// `responseType: "text"` because the source is a tab-separated dump, not JSON.
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
 *   GENERATED — do not edit by hand. Per-country population, derived from GeoNames countryInfo.txt
 *   (https://download.geonames.org/export/dump/countryInfo.txt, CC-BY-4.0). Estimates are
 *   census-vintage; a prominence race reads the magnitude, not the currency. Countries GeoNames
 *   declines to estimate are ABSENT, never zero.
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
