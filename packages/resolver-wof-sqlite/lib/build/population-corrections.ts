/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Populations the gazetteer records at a fraction of their size, corrected against the record's own concordance.
 *
 *   A REVIEW QUEUE, not a campaign. `same-name-parent-population.run.ts` reports 964 localities whose population is a
 *   fraction of their same-name parent's, and #2269 refuses to rewrite them from that signal: the detector cannot tell
 *   a district's mis-recorded namesake city from a small village sharing the district name, and both ends are real —
 *   three separate `Sultanpur` rows at 226, 235 and 255 people inside Sultanpur district are plausibly three villages.
 *   A build step that rewrote 964 populations on a ratio would invent numbers.
 *
 *   An entry here is therefore one row someone followed to a second source and read. The bar is the row's own
 *   `gn:id` concordance, the coordinates agreeing, and the GeoNames record naming the same place — not the ratio that
 *   surfaced it.
 *
 *   THIS CORRECTS THE CANDIDATE ARTIFACT, NOT THE ADMIN GAZETTEER. `place_population` in
 *   `admin-global-priority.db` still carries the WOF figure, so a reader going there sees what WOF says and a reader
 *   going to `candidate.db` sees the corroborated number. That split is deliberate: the admin database is a
 *   transcription of its source and correcting it there would make the transcription disagree with what it transcribes.
 */

/**
 * One corrected population, with what corroborates it.
 */
export interface PopulationCorrection {
	/**
	 * The GeoNames id from the WOF record's own `concordances` row, which is what makes this a correction rather than a
	 * substitution: the two sources are describing the same place because WOF says so.
	 */
	geonamesID: string
	/**
	 * The population the second source states.
	 */
	population: number
	/**
	 * What the gazetteer recorded, kept so a reader can see the size of the disagreement without opening the artifact.
	 */
	recorded: number
	/**
	 * The place, and the reading a reviewer made.
	 */
	note: string
}

/**
 * WOF id → the corrected population.
 *
 * One entry, because one row has been followed. Adding a second is the same work again: read the row's `gn:id`, confirm
 * the coordinates agree, and state what the second source says.
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
