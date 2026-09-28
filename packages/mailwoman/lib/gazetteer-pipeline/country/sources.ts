/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Which source serves a country's admin coverage, and what it costs when more than one does.
 *
 * The WOF leg is presence-driven while Overture and GeoNames are list-driven, so the fourteen
 * baseline Overture + GeoNames pairs are accepted and a fifteenth is refused.
 */

/**
 * A source that can serve a country's admin coverage.
 */
export const AdminSource = {
	/**
	 * Cloned WOF GeoJSON repos, ingested by presence.
	 */
	WOF: "wof",
	/**
	 * The Overture `divisions`-theme backfill, `DEFAULT_OVERTURE_COUNTRIES`.
	 */
	Overture: "overture",
	/**
	 * The GeoNames fold, `DEFAULT_GEONAMES_COUNTRIES`; it writes `spr` places
	 * (`locality` with `parent_id = -1`) rather than only alternate names.
	 */
	GeoNames: "geonames",
} as const

export type AdminSource = (typeof AdminSource)[keyof typeof AdminSource]

/**
 * The countries accepted as two-source (Overture + GeoNames); removing an entry is
 * a coverage decision and adding one is what this module refuses.
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
 * `wofCountries` is passed in rather than read from `DEFAULT_WOF_PRIORITY_COUNTRIES` because the WOF
 * leg is presence-driven: a build check passes what is on disk, a recipe check passes the list.
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
 * Countries served by more than one source that the baseline does not already record;
 * a WOF conflict is reported regardless.
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
