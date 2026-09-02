/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a loaded gazetteer artifact declares about its own country coverage, and the one derivation the
 *   reader and the build share. A country ABSENT from a coverage map was never measured — never measured and
 *   failed; the failed case is present with `hardFilterSafe: false`.
 */

/**
 * One country's measured hard-filter coverage fact, as recorded at a promote eval. Facts about the gazetteer artifact
 * live IN the artifact (the `country_coverage` table the gazetteer build emits) — code constants are only the fallback
 * for artifacts that predate the manifest.
 *
 * Meaning-of-zero discipline: a country ABSENT from the coverage map was never measured — never "measured and failed".
 * A measured-and-failed country is PRESENT with `hardFilterSafe: false` (e.g. FI at 69.5% hard-resolve), so the
 * negative result is a first-class record, distinguishable from ignorance.
 */
export interface CountryCoverageFact {
	/**
	 * ISO 3166-1 alpha-2, uppercase.
	 */
	country: string
	/**
	 * The promote-gate VERDICT: hard-filtering this country is a pure win (a hard-filter miss is almost always a genuine
	 * non-match, not a coverage gap). Stored as a verdict — not re-derived from `hardResolveRate` at read time — because
	 * the check is a judgment over a panel, not a pure rate function (CA cleared at the #928 promote on the
	 * postcode-format-prior rationale despite a sub-95% panel resolve rate).
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
 * Facts a loaded gazetteer artifact declares about itself — read from the artifact's own manifest tables at open time,
 * carried on the {@link ResolverBackend}/{@link Resolver} handle so consumers read the facts from the artifact they are
 * actually resolving against. `undefined` on the handle = the artifact predates the manifest → consumers fall back to
 * the code constants (byte-identical legacy behavior).
 */
export interface GazetteerArtifactCoverage {
	/**
	 * Country → measured coverage fact. ABSENCE = never measured (meaning-of-zero), never "failed".
	 */
	countryCoverage: ReadonlyMap<string, CountryCoverageFact>
	/**
	 * Country → guard-B bbox. ABSENCE = no box → the plausibility guard fails open for that country.
	 */
	countryBBoxes: ReadonlyMap<string, CountryBBoxFact>
	/**
	 * Derived at load: the countries whose fact says `hardFilterSafe` — the artifact's hard-country safelist.
	 */
	hardCountrySafelist: ReadonlySet<string>
}

/**
 * Derive the hard-country safelist from coverage facts — the ONE derivation both the reader and the build share.
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
