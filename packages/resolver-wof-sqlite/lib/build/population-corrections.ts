/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Populations the gazetteer records at a fraction of their size, corrected against the record's own concordance.
 *
 *   This file records corrections for review. The build must not rewrite populations from a
 *   same-name-parent ratio. The detector cannot distinguish a district's mis-recorded namesake
 *   city from a small village with the district name. Both places are real.
 *
 *   Each entry identifies one row that a reviewer checked against a second source.
 *   The row's own `gn:id` must agree with the coordinates. The GeoNames record must identify the same place.
 *
 *   The correction applies to the candidate artifact rather than the admin gazetteer.
 *   `place_population` in `admin-global-priority.db` still stores the WOF figure, so a reader going
 *   there sees WOF's value and a reader going to `candidate.db` sees the corroborated number. The
 *   admin database is a transcription of its source, so correcting it there would make the
 *   transcription disagree with what it transcribes.
 */

/**
 * One corrected population, with what corroborates it.
 */
export interface PopulationCorrection {
	/**
	 * The GeoNames id from the WOF record's own `concordances` row makes this a
	 * correction rather than a substitution.
	 *
	 * The two sources describe the same place according to WOF.
	 */
	geonamesID: string
	population: number
	/**
	 * What the gazetteer recorded, kept so a reader can see the size of the
	 * disagreement without opening the artifact.
	 */
	recorded: number
	/**
	 * The place and the reviewer's reading.
	 */
	note: string
}

/**
 * WOF id → the corrected population.
 *
 * One entry, because one row has been followed.
 * A second correction requires the same review.
 *
 * Read the row's `gn:id` and confirm the coordinates agree.
 * Then record the second source's value.
 */
export const POPULATION_CORRECTIONS: Readonly<Record<number, PopulationCorrection>> = {
	102_030_887: {
		geonamesID: "1278149",
		population: 1_175_116,
		recorded: 19_172,
		note:
			"Aurangabad (Chhatrapati Sambhaji Nagar), Maharashtra. The WOF record sits at 19.870 / 75.349 and GeoNames " +
			"1278149 — the id that record's own concordance names — sits at 19.878 / 75.342, about 1 km apart, classed " +
			"`PPLA2`. WOF's 19,172 against its parent district's 3,701,282 is the 193x ratio that surfaced it; the " +
			"corroborated figure makes the city 32% of its district rather than 0.5% of it.",
	},
}
