/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a loaded gazetteer artifact declares about its own country coverage, and the one derivation
 *   the reader and the build share. A country absent from a coverage map was never measured. A
 *   measured-and-failed country is present with `hardFilterSafe: false`.
 */

/**
 * One country's measured hard-filter coverage fact, as recorded at a promote eval.
 *
 * Facts about the gazetteer artifact live in the artifact, in the `country_coverage`
 * table the gazetteer build emits.
 * Code constants are the fallback for artifacts that predate the manifest.
 *
 * A country absent from the coverage map was never measured.
 * A measured-and-failed country is present with `hardFilterSafe: false`,
 * so the negative result is a first-class record.
 */
export interface CountryCoverageFact {
	/**
	 * ISO 3166-1 alpha-2, uppercase.
	 */
	country: string
	/**
	 * The promotion-eval verdict that hard-filtering this country is a pure win.
	 * A hard-filter miss is almost always a genuine non-match.
	 *
	 * Stored as a verdict rather than re-derived from `hardResolveRate` at read time,
	 * since it is a judgment over a panel.
	 */
	hardFilterSafe: boolean
	/**
	 * Measured hard-resolve rate (0..1) on the panel named in `source`, when the receipt recorded one.
	 */
	hardResolveRate?: number
	/**
	 * Panel size behind `hardResolveRate`, when recorded.
	 */
	sampleSize?: number
	/**
	 * ISO-8601 date of the measurement / promote eval.
	 */
	measuredAt: string
	/**
	 * The receipt: which panel/check produced this row (issue + date, human-readable).
	 */
	source: string
}

/**
 * One country's coarse guard-B bounding box, as carried by the gazetteer artifact's `country_bbox` table.
 */
export interface CountryBBoxFact {
	/**
	 * ISO 3166-1 alpha-2, uppercase.
	 */
	country: string
	latMin: number
	latMax: number
	lonMin: number
	lonMax: number
	/**
	 * Provenance of the box (harness + date).
	 */
	source: string
}

/**
 * Facts a loaded gazetteer artifact declares about itself.
 *
 * Read from the artifact's own manifest tables at open time, carried on the
 * {@link ResolverBackend}/{@link Resolver} handle so consumers read the facts from
 * the artifact they are actually resolving against.
 *
 * `undefined` on the handle means the artifact predates the manifest, and consumers fall
 * back to the code constants, which keeps the legacy behavior byte-identical.
 */
export interface GazetteerArtifactCoverage {
	/**
	 * Country to measured coverage fact.
	 * Absence means the country was never measured.
	 */
	countryCoverage: ReadonlyMap<string, CountryCoverageFact>
	/**
	 * Country to guard-B bbox.
	 *
	 * Absence means no box, so the plausibility guard fails open for that country.
	 */
	countryBBoxes: ReadonlyMap<string, CountryBBoxFact>
	/**
	 * Derived at load.
	 *
	 * The countries whose fact says `hardFilterSafe`, the artifact's hard-country safelist.
	 */
	hardCountrySafelist: ReadonlySet<string>
}

/**
 * Derive the hard-country safelist from coverage facts, the one derivation
 * both the reader and the build share.
 */
export function hardCountrySafelistFromCoverage(facts: Iterable<CountryCoverageFact>): ReadonlySet<string> {
	const out = new Set<string>()

	for (const fact of facts) {
		if (fact.hardFilterSafe) {
			out.add(fact.country.toUpperCase())
		}
	}

	return out
}
