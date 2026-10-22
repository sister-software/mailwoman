/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The home page's coverage table, condensed from the reference page `locales-and-tiers.mdx`.
 *   That page is the record: change it first, then this list.
 */

export interface CoverageRow {
	region: string
	/**
	 * The parser claim tier from the reference page, or `null` where no locale is claimed.
	 */
	parserTier: number | null
	/**
	 * Whether a locale weights overlay is published.
	 */
	overlay: boolean
	/**
	 * The street data bundle, or `null` where only `candidate` answers.
	 */
	streetBundle: string | null
	/**
	 * The finest tier the published artifacts reach.
	 */
	bestTier: string
}

/**
 * Rows in the reference page's order: the street-data countries, then the overlays, then everywhere else.
 */
export const CoverageRows: readonly CoverageRow[] = [
	{ region: "United States", parserTier: 1, overlay: true, streetBundle: "us", bestTier: "address point" },
	{ region: "France", parserTier: 1, overlay: true, streetBundle: "fr", bestTier: "address point" },
	{ region: "Germany", parserTier: 2, overlay: true, streetBundle: null, bestTier: "admin" },
	{ region: "Spain", parserTier: 2, overlay: true, streetBundle: null, bestTier: "admin" },
	{ region: "Italy", parserTier: 2, overlay: true, streetBundle: null, bestTier: "admin" },
	{ region: "Great Britain", parserTier: null, overlay: true, streetBundle: null, bestTier: "admin" },
	{ region: "New Zealand", parserTier: null, overlay: true, streetBundle: null, bestTier: "admin" },
	{ region: "India", parserTier: null, overlay: true, streetBundle: null, bestTier: "admin" },
	{
		region:
			"Portugal, Poland, Austria, Czechia, Australia, Belgium, Netherlands, Switzerland, Croatia, Denmark, Finland",
		parserTier: 2,
		overlay: false,
		streetBundle: null,
		bestTier: "admin",
	},
	{ region: "Norway, Sweden", parserTier: 3, overlay: false, streetBundle: null, bestTier: "admin" },
	{ region: "Japan", parserTier: 5, overlay: false, streetBundle: null, bestTier: "postcode" },
	{
		region: "Everywhere else, 244 countries in all",
		parserTier: null,
		overlay: false,
		streetBundle: null,
		bestTier: "admin",
	},
]
