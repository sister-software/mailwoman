// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `prominent-places`: each country's prominent places in their short query shapes (#3156).
 *
 *   The input is the tuple file the prominent-places census writes
 *   (`packages/mailwoman/tools/dev-tools/corpus/prominent/places.run.ts tuples`): one line
 *   per prominent Who's On First locality or sub-locality, with its parent locality, region
 *   and region abbreviations from the candidate table, and the rows to write in each shape.
 *   Every country is ranked and drawn by the same rule from the same sources, and the census,
 *   never this recipe, sets the row counts, stratified by country, placetype band and shape.
 *
 *   {@linkcode prominentPlaceTag} is the #3156 label policy.
 *   The launch receipt reads it too:
 *
 *   - A locality is written as `locality` in every shape.
 *   - A sub-locality is written as `dependent_locality` beside the parent locality
 *     WOF's hierarchy records (`Camden, London`).
 *   - A sub-locality written bare or with its region or country gets no row.
 *     `dependent_locality` without a locality is never written, and its postal reading is unresolved.
 *
 *   The text of every row is a WOF name, a WOF region abbreviation, a codex country form,
 *   or the runtime's English region name for a territory WOF records under no country.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { countrySurfaceForms } from "@mailwoman/codex/country/country"
import { stringifyJSON } from "@mailwoman/core/json"
import { JSONSpliterator } from "spliterator"

import { COUNTRY_DISPLAY_NAME, LOCALE_BY_COUNTRY, renderHierarchy } from "#adapters/wof/json-rows"
import { alignAndWrite, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

/**
 * The placetype bands a place is ranked within, each a set of WOF placetypes.
 *
 * A borough sits in the sub-locality band because WOF parents it under a locality
 * (Brooklyn under New York, Camden under London).
 */
export const PLACE_BANDS = {
	locality: ["locality", "localadmin"],
	sublocality: ["borough", "macrohood", "neighbourhood", "microhood"],
} as const satisfies Record<string, readonly string[]>

/**
 * One placetype band.
 */
export type PlaceBand = keyof typeof PLACE_BANDS

/**
 * The short query shapes, by how the second segment relates to the place.
 */
export const QUERY_SHAPES = ["bare", "parent", "region", "region_abbr", "country"] as const

/**
 * One query shape.
 */
export type QueryShape = (typeof QUERY_SHAPES)[number]

/**
 * The tag a place's own span takes in one shape, or `null` when the recipe writes no row in the shape.
 *
 * The launch receipt requires the same tag, and defers a shape this returns `null` for.
 *
 * A sub-locality written bare or with its region or country is its postal form.
 * The only planetary evidence for that reading is a GeoNames postal-name match.
 *
 * The #3156 decision treats such a match as provisional.
 * GeoNames' postal export gives `N1C` and `NW1W` the place name `Camden`, although their
 * post town is London, so even a match that lies on the place can't decide the label.
 * Those forms wait for a postal authority's own list.
 */
export function prominentPlaceTag(band: PlaceBand, shape: QueryShape): "locality" | "dependent_locality" | null {
	if (band === "locality") return shape === "parent" ? null : "locality"

	return shape === "parent" ? "dependent_locality" : null
}

/**
 * One prominent place as the census writes it for this recipe.
 */
export interface ProminentPlaceTuple {
	spr_id: number
	country: string
	band: PlaceBand
	name: string
	parent_locality: string | null
	region: string | null
	region_abbrs: readonly string[]
	/**
	 * The country's WOF name, or its English region name for a territory WOF records under no
	 * country or dependency, written when the codex lists no display name for the country.
	 */
	country_name: string | null
	/**
	 * The rows to write in each shape.
	 * A shape without a count gets none.
	 */
	rows: Partial<Record<QueryShape, number>>
}

/**
 * The shortest country form a row writes.
 *
 * A two-letter code reads as a region abbreviation (`CA`), as `packages/corpus/AGENTS.md`
 * records for country-implicit sources.
 */
const COUNTRY_FORM_MIN_LENGTH = 3

/**
 * The second segment's tag and its written forms in one shape, or `null` when the place has none.
 */
function secondForms(
	tuple: ProminentPlaceTuple,
	shape: QueryShape
): { tag: ComponentTag | null; forms: readonly string[] } | null {
	switch (shape) {
		case "bare":
			return { tag: null, forms: [""] }
		case "parent":
			return tuple.parent_locality ? { tag: "locality", forms: [tuple.parent_locality] } : null
		case "region":
			return tuple.region ? { tag: "region", forms: [tuple.region] } : null
		case "region_abbr":
			return tuple.region_abbrs.length ? { tag: "region", forms: tuple.region_abbrs } : null
		case "country": {
			const forms = [
				COUNTRY_DISPLAY_NAME[tuple.country] ?? tuple.country_name,
				...countrySurfaceForms(tuple.country),
			].filter((form): form is string => typeof form === "string" && form.length >= COUNTRY_FORM_MIN_LENGTH)

			return forms.length ? { tag: "country", forms: [...new Set(forms)] } : null
		}
	}
}

/**
 * The case forms of one row's components: as written, then upper and lower case where the script has case.
 */
function caseForms(components: Partial<Record<ComponentTag, string>>): Array<Partial<Record<ComponentTag, string>>> {
	const forms = [components]

	for (const change of [(value: string) => value.toUpperCase(), (value: string) => value.toLowerCase()]) {
		const changed = Object.fromEntries(Object.entries(components).map(([tag, value]) => [tag, change(value!)]))

		if (!forms.some((form) => stringifyJSON(form) === stringifyJSON(changed))) {
			forms.push(changed)
		}
	}

	return forms
}

/**
 * One rendered row before alignment.
 */
export interface ProminentPlaceRow {
	shape: QueryShape
	raw: string
	components: Partial<Record<ComponentTag, string>>
	sourceID: string
}

const PROMINENT_PLACES_SOURCE = defaultRecipeSource("synth-prominent-places")

/**
 * The distinct components one place is written with in one shape:
 * each second-segment form in each case form.
 *
 * A shape the label policy leaves unwritten, or one the place has no second segment for, has none.
 */
function prominentPlaceVariants(
	tuple: ProminentPlaceTuple,
	shape: QueryShape
): Array<Partial<Record<ComponentTag, string>>> {
	const tag = prominentPlaceTag(tuple.band, shape)
	const second = secondForms(tuple, shape)

	if (!tag || !second) return []

	return second.forms.flatMap((form) => {
		const rendered = renderHierarchy(
			second.tag ? { [tag]: tuple.name, [second.tag]: form } : { [tag]: tuple.name },
			tuple.country
		)

		return rendered ? caseForms(rendered.components) : []
	})
}

/**
 * Every row one place writes: in each shape with a count, its variants in turn until the count is written.
 *
 * A count larger than the variants repeats them, and each repetition takes its own `source_id`.
 */
export function prominentPlaceRows(tuple: ProminentPlaceTuple): ProminentPlaceRow[] {
	const rows: ProminentPlaceRow[] = []

	for (const shape of QUERY_SHAPES) {
		const count = tuple.rows[shape] ?? 0
		const variants = count ? prominentPlaceVariants(tuple, shape) : []

		if (!variants.length) continue

		for (let index = 0; index < count; index++) {
			const rendered = renderHierarchy(variants[index % variants.length]!, tuple.country)

			if (!rendered) continue

			rows.push({
				shape,
				raw: rendered.raw,
				components: rendered.components,
				sourceID: recipeSourceID(PROMINENT_PLACES_SOURCE, { place: String(tuple.spr_id), shape, v: String(index) }),
			})
		}
	}

	return rows
}

const LICENSE = "Who's On First — prominent-places; locality, sub-locality and region records (CC0)"

/**
 * The `prominent-places` recipe.
 */
export const prominentPlacesRecipe: CorpusRecipe = {
	name: "prominent-places",
	description:
		"Each country's prominent WOF localities and sub-localities, bare and with their parent locality, region, " +
		"region abbreviation or country, at the row counts the prominent-places census sets (#3156)",
	mode: "tuples",
	async run(opts, write) {
		if (!opts.input) throw new Error("prominent-places needs --input <prominent-tuples.jsonl>")

		let read = 0
		let emitted = 0
		let skipped = 0

		// A malformed line throws, so a run never writes part of the census's counts as if they were all of them.
		for await (const tuple of JSONSpliterator.fromAsync<ProminentPlaceTuple>(opts.input.toString())) {
			read++

			for (const row of prominentPlaceRows(tuple)) {
				const written = alignAndWrite(
					write,
					{
						raw: row.raw,
						components: row.components,
						country: tuple.country,
						locale: LOCALE_BY_COUNTRY[tuple.country] ?? "und",
						source: PROMINENT_PLACES_SOURCE,
						source_id: row.sourceID,
						license: LICENSE,
					},
					`prominent-places:${tuple.band}:${row.shape}`,
					{
						register: SourceRegister.WhosOnFirst,
						surface: SurfaceOrigin.Rendered,
						// Every row of one place shares its WOF record's group, so a split keeps them on one side.
						baseSourceID: `wof-admin-${tuple.spr_id}`,
					}
				)

				if (written) {
					emitted++
				} else {
					skipped++
				}
			}
		}

		return { read, emitted, skipped }
	},
}
