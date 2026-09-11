/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which source serves a country's admin coverage, and what it costs when more than one does.
 *
 *   Three sources feed the admin gazetteer and each is selected differently: the WOF leg is
 *   PRESENCE-driven (`ingestWOF` globs `**\/data\/**\/*.geojson` over the repos root and reads no list),
 *   while Overture and GeoNames are LIST-driven from `defaults.ts`. So adding a country by cloning is half
 *   the job; the other half is removing it from whichever list serves it today, and nothing enforced the
 *   pairing.
 *
 *   THE INVARIANT IS NOT "ONE COUNTRY, ONE SOURCE", and that matters because the runbook this came from
 *   states it as though it were. Measured against the shipped `admin-global-priority.db` on 2026-08-17:
 *   245 countries, 231 single-source, **14 two-source** (all Overture + GeoNames), 0 three-source. The
 *   fourteen are not drift — the config lists agree with the artifact exactly.
 *
 *   Nor are they simply waste. Name overlap between the two folds, per country:
 *
 *   | Country | GeoNames names | Overture names | Shared |
 *   | ------- | -------------- | -------------- | ------ |
 *   | CZ      | 11,904         | 11,918         | 9,800  |
 *   | FI      | 20,759         | 9,744          | 8,668  |
 *   | PL      | 33,484         | 61,802         | 26,490 |
 *
 *   So 79–89% of each GeoNames set is already in Overture — real duplication, and it is what produces the
 *   coincident same-name rows the resolver then has to arbitrate. But FI gains roughly 12,000 names
 *   Overture does not carry, so dropping the fold wholesale would lose coverage. Both facts are true, and
 *   a check that refused two sources would be refusing a deliberate trade.
 *
 *   Hence the rule this module encodes: the FOURTEEN are accepted and recorded; a FIFTEENTH is refused.
 *   An existing trade someone measured is not the same thing as a country silently acquiring a second
 *   source because a clone landed and a list was never edited.
 */

/**
 * A source that can serve a country's admin coverage.
 */
export const AdminSource = {
	/**
	 * Cloned WOF GeoJSON repos, ingested by presence. Not list-driven — see the module docstring.
	 */
	WOF: "wof",
	/**
	 * The Overture `divisions`-theme backfill, `DEFAULT_OVERTURE_COUNTRIES`.
	 */
	Overture: "overture",
	/**
	 * The GeoNames fold, `DEFAULT_GEONAMES_COUNTRIES`. Despite the ingest function's name it writes `spr` PLACES, not
	 * only alternate names: the rows are `locality` with `parent_id = -1`.
	 */
	GeoNames: "geonames",
} as const

export type AdminSource = (typeof AdminSource)[keyof typeof AdminSource]

/**
 * The countries measured as two-source on 2026-08-17, with Overture + GeoNames, against both the config lists and the
 * shipped artifact.
 *
 * A baseline, not a permission slip. It exists so a NEW double-listing is distinguishable from the fourteen that were
 * already there — the difference between a trade someone made and an accident nobody noticed. Removing an entry is a
 * coverage decision (see the overlap table above); adding one is what this module refuses.
 */
export const ACCEPTED_TWO_SOURCE_COUNTRIES: ReadonlySet<string> = new Set([
	"AT",
	"BE",
	"CH",
	"CZ",
	"DK",
	"FI",
	"HR",
	"LT",
	"LU",
	"LV",
	"NO",
	"PL",
	"SI",
	"SK",
])

export interface CountrySources {
	country: string
	sources: AdminSource[]
}

/**
 * A country that gained a source it did not have in the baseline.
 */
export interface SourceConflict {
	country: string
	sources: AdminSource[]
	reason: string
}

/**
 * Map every country to the sources that serve it, from the three lists.
 *
 * `wofCountries` is passed in rather than read from `DEFAULT_WOF_PRIORITY_COUNTRIES` because that list is a DECLARATION
 * and the WOF leg is presence-driven: what actually gets ingested is whatever is cloned. A caller checking a build
 * should pass what is on disk; a caller checking the recipe should pass the list. Conflating them is how a clone that
 * nobody declared, or a declaration nobody cloned, reads as fine.
 */
export function countrySourceMap(lists: {
	wofCountries: readonly string[]
	overtureCountries: readonly string[]
	geonamesCountries: readonly string[]
}): CountrySources[] {
	const map = new Map<string, Set<AdminSource>>()

	const add = (countries: readonly string[], source: AdminSource): void => {
		for (const raw of countries) {
			const country = raw.toUpperCase()

			map.set(country, (map.get(country) ?? new Set()).add(source))
		}
	}

	add(lists.wofCountries, AdminSource.WOF)
	add(lists.overtureCountries, AdminSource.Overture)
	add(lists.geonamesCountries, AdminSource.GeoNames)

	return [...map]
		.map(([country, sources]) => ({ country, sources: [...sources].toSorted() }))
		.toSorted((a, b) => a.country.localeCompare(b.country))
}

/**
 * Countries served by more than one source that the baseline does not already record.
 *
 * A WOF conflict is reported regardless of the baseline: every entry in {@link ACCEPTED_TWO_SOURCE_COUNTRIES} is
 * Overture + GeoNames, so a country that gains WOF coverage while staying on a list is the #267 case the comments
 * warned about — the clone landed and the list was never edited.
 */
export function sourceConflicts(sources: readonly CountrySources[]): SourceConflict[] {
	return sources
		.filter((entry) => entry.sources.length > 1)
		.filter((entry) => entry.sources.includes(AdminSource.WOF) || !ACCEPTED_TWO_SOURCE_COUNTRIES.has(entry.country))
		.map((entry) => ({
			...entry,
			reason: entry.sources.includes(AdminSource.WOF)
				? `${entry.country} is cloned as a WOF repo AND listed under ${entry.sources
						.filter((s) => s !== AdminSource.WOF)
						.join(" + ")} — both fold into one database, and verifyAdmin tests FLOORS, so the duplication moves ` +
					"every check number in the passing direction and the build ships"
				: `${entry.country} is served by ${entry.sources.join(" + ")}, which the 2026-08-17 baseline does not record ` +
					"— an existing measured trade is not the same as a country silently acquiring a second source",
		}))
}

/**
 * The one sentence a caller relays.
 */
export function sourceSentence(sources: readonly CountrySources[], conflicts: readonly SourceConflict[]): string {
	const multi = sources.filter((s) => s.sources.length > 1).length

	return (
		`${sources.length} countries: ${sources.length - multi} single-source, ${multi} multi-source ` +
		`(${ACCEPTED_TWO_SOURCE_COUNTRIES.size} recorded in the baseline)` +
		`${conflicts.length ? `, ${conflicts.length} UNRECORDED` : ", none unrecorded"}.`
	)
}
