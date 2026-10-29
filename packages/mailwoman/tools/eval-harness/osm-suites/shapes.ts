/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address shapes the OpenStreetMap suites test, read from a rendered row's annotated spans. Each is a
 *   shape the publisher-labeled comparison sources could not supply with mapper-written answers: a secondary
 *   unit, a dependent locality written before its city, a region written after the locality, and a house
 *   number within a place, such as an estate, where no street exists.
 */

import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

/**
 * The suites, one per shape.
 */
export const OSMSuiteShape = {
	/**
	 * The row has a `unit` span (`addr:unit`), such as the Norwegian `H0101` or a US suite.
	 */
	Unit: "unit",
	/**
	 * A `dependent_locality` span starts before the `locality` span, such as `Altona, Hamburg`.
	 */
	SuburbBeforeCity: "suburb-before-city",
	/**
	 * A `region` span starts after the `locality` span, such as an Australian state code after the suburb.
	 */
	RegionAfterLocality: "region-after-locality",
	/**
	 * A `house_number` span with no `street` span: a number within a place such as `DHA Phase 6`.
	 */
	PlaceWithoutStreet: "place-without-street",
} as const

export type OSMSuiteShape = (typeof OSMSuiteShape)[keyof typeof OSMSuiteShape]

/**
 * The predicate each suite applies, in words, recorded in its lineage as the row filter.
 */
export const OSM_SUITE_SHAPE_FILTERS: Readonly<Record<OSMSuiteShape, string>> = {
	[OSMSuiteShape.Unit]: "the rendered row has a unit span",
	[OSMSuiteShape.SuburbBeforeCity]: "a dependent_locality span starts before the locality span",
	[OSMSuiteShape.RegionAfterLocality]: "a region span starts after the locality span",
	[OSMSuiteShape.PlaceWithoutStreet]: "a house_number span and no street span",
}

function firstStart(row: Pick<HeldoutRow, "span_starts" | "span_tags">, tag: string): number | null {
	const index = row.span_tags.indexOf(tag)

	return index === -1 ? null : row.span_starts[index]!
}

/**
 * Every shape a row has.
 *
 * A row may have several, such as a unit in a row that also writes a region last.
 */
export function suiteShapesOf(row: Pick<HeldoutRow, "span_starts" | "span_tags">): OSMSuiteShape[] {
	const shapes: OSMSuiteShape[] = []
	const locality = firstStart(row, "locality")
	const dependent = firstStart(row, "dependent_locality")
	const region = firstStart(row, "region")

	if (row.span_tags.includes("unit")) {
		shapes.push(OSMSuiteShape.Unit)
	}

	if (dependent !== null && locality !== null && dependent < locality) {
		shapes.push(OSMSuiteShape.SuburbBeforeCity)
	}

	if (region !== null && locality !== null && region > locality) {
		shapes.push(OSMSuiteShape.RegionAfterLocality)
	}

	if (row.span_tags.includes("house_number") && !row.span_tags.includes("street")) {
		shapes.push(OSMSuiteShape.PlaceWithoutStreet)
	}

	return shapes
}
