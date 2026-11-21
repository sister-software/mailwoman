// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `former-divisions`: a former administrative division written beside a locality it covered.
 *
 *   The input is the tuple file `packages/gazetteer/tools/former-divisions.run.ts --tuples`
 *   writes: one line per row, naming a division of the former divisions table,
 *   a current WOF locality its containment evidence links it to, and the shape to write.
 *   That tool, never this recipe, sets the row counts, capped and stratified by country
 *   and division by one rule for every country.
 *
 *   Two shapes place the division:
 *
 *   - `division_first`: before the locality, the order Google writes, `Redland, Avon, Bristol`.
 *   - `division_after`: after the locality, the conventional order, `Redland, Bristol, Avon`.
 *
 *   The division takes the tag the table states, `subregion` at county level
 *   or `region` at the first level (`docs/engineering/reference/SCHEMA.mdx`).
 *   A dependent locality, a postcode and a country are written when the tuple states them.
 *
 *   A postcode sits where `POSTCODE_CONVENTIONS` places it for the country,
 *   and a country the table doesn't list gets no postcode.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { JSONSpliterator } from "spliterator"

import { LOCALE_BY_COUNTRY } from "#adapters/wof/json-rows"
import { alignAndWrite, type CorpusRecipe, type PostcodePlacement, recipeSourceID } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

/**
 * Where the division sits relative to the locality.
 */
export const FORMER_DIVISION_SHAPES = ["division_first", "division_after"] as const

export type FormerDivisionShape = (typeof FORMER_DIVISION_SHAPES)[number]

/**
 * One row as the tuple file states it.
 */
export interface FormerDivisionTuple {
	country: string
	division: string
	division_tag: "subregion" | "region"
	/**
	 * `geonames:<id>` or `wof:<id>`.
	 */
	division_id: string
	/**
	 * The WOF id of the locality.
	 */
	settlement_id: number
	locality: string
	dependent_locality: string | null
	postcode: string | null
	postcode_placement: PostcodePlacement | null
	/**
	 * The country form to end the row with, or `null` for none.
	 */
	country_name: string | null
	shape: FormerDivisionShape
	/**
	 * The tuple's index among its division's rows, so a repeated tuple takes its own `source_id`.
	 */
	index: number
}

/**
 * The text and components of one tuple's row.
 */
export function formerDivisionRow(tuple: FormerDivisionTuple): {
	raw: string
	components: Partial<Record<ComponentTag, string>>
} {
	const components: Partial<Record<ComponentTag, string>> = {
		locality: tuple.locality,
		[tuple.division_tag]: tuple.division,
	}

	const postcode = tuple.postcode && tuple.postcode_placement ? tuple.postcode : null

	let locality = tuple.locality

	if (postcode && tuple.postcode_placement === "after_locality") {
		locality = `${tuple.locality} ${postcode}`
	} else if (postcode && tuple.postcode_placement === "leading") {
		locality = `${postcode} ${tuple.locality}`
	}

	const admin = tuple.shape === "division_first" ? [tuple.division, locality] : [locality, tuple.division]

	if (postcode && tuple.postcode_placement === "after_region") {
		admin[admin.length - 1] = `${admin.at(-1)} ${postcode}`
	}

	const segments = [...(tuple.dependent_locality ? [tuple.dependent_locality] : []), ...admin]

	if (tuple.dependent_locality) {
		components.dependent_locality = tuple.dependent_locality
	}

	if (postcode) {
		components.postcode = postcode
	}

	if (tuple.country_name) {
		components.country = tuple.country_name
		segments.push(tuple.country_name)
	}

	return { raw: segments.join(", "), components }
}

const FORMER_DIVISIONS_SOURCE = defaultRecipeSource("synth-former-divisions")

const LICENSE =
	"GeoNames historical divisions and postal codes (CC BY 4.0); Who's On First locality and ceased admin records (CC0)"

/**
 * The `former-divisions` recipe.
 */
export const formerDivisionsRecipe: CorpusRecipe = {
	name: "former-divisions",
	description:
		"A former administrative division beside a WOF locality it covered, before or after the locality, " +
		"at the row counts the former-divisions tool sets",
	mode: "tuples",
	async run(opts, write) {
		if (!opts.input) throw new Error("former-divisions needs --input <former-division-tuples.jsonl>")

		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const tuple of JSONSpliterator.fromAsync<FormerDivisionTuple>(opts.input.toString())) {
			read++

			const row = formerDivisionRow(tuple)

			const written = alignAndWrite(
				write,
				{
					raw: row.raw,
					components: row.components,
					country: tuple.country,
					locale: LOCALE_BY_COUNTRY[tuple.country] ?? "und",
					source: FORMER_DIVISIONS_SOURCE,
					source_id: recipeSourceID(FORMER_DIVISIONS_SOURCE, {
						division: tuple.division_id,
						place: String(tuple.settlement_id),
						shape: tuple.shape,
						v: String(tuple.index),
					}),
					license: LICENSE,
				},
				`former-divisions:${tuple.division_tag}:${tuple.shape}`,
				{
					register: SourceRegister.GeoNames,
					surface: SurfaceOrigin.Composed,
					// A locality's rows share its WOF record's group, so a split keeps them beside its `wof-admin` rows.
					baseSourceID: `wof-admin-${tuple.settlement_id}`,
				}
			)

			if (written) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped }
	},
}
