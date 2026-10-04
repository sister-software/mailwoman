/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A reading of one spatial layer over one extent. Zero records means absence only when the layer's
 *   coverage basis supports an exclusion. A `source_present` layer that found no record says the source
 *   looked, and absence stays unknown. A positive reading beside an empty one is a conflict to show.
 */

import { type CoverageBasis, supportsExclusion } from "@mailwoman/evidence"

import type { Evidence } from "#links"
import type { ISODate } from "#time"

export interface LayerReading {
	layer: string
	/**
	 * The surveyed extent as the layer states it, such as an H3 cell or a named area.
	 */
	extent: string
	basis: CoverageBasis | null
	surveyedAt?: ISODate
	/**
	 * `null` when the layer has no survey for the extent.
	 */
	records: number | null
	evidence: Evidence
}

/**
 * The classes a layer reading can take, as wire values: no survey, a surveyed empty, an empty
 * that supports no exclusion, records present, and a positive reading beside an empty one.
 */
export const LayerReadingClass = {
	Unknown: "unknown",
	SurveyedEmpty: "surveyed_empty",
	SourcePresentEmpty: "source_present_empty",
	Records: "records",
	Conflicting: "conflicting",
} as const

export type LayerReadingClass = (typeof LayerReadingClass)[keyof typeof LayerReadingClass]

export function classifyReading(reading: LayerReading): LayerReadingClass {
	if (reading.records === null) return LayerReadingClass.Unknown

	if (reading.records > 0) return LayerReadingClass.Records

	return supportsExclusion({ basis: reading.basis })
		? LayerReadingClass.SurveyedEmpty
		: LayerReadingClass.SourcePresentEmpty
}

/**
 * Classifies readings of one layer and extent together.
 *
 * Readings on other layers or extents are left out of the combined class
 * and should be classified by their own call.
 */
export function classifyReadings(readings: readonly LayerReading[]): {
	class: LayerReadingClass
	readings: readonly LayerReading[]
} {
	const [first] = readings

	if (!first) throw new Error("classifyReadings: no readings supplied")

	const same = readings.filter((reading) => reading.layer === first.layer && reading.extent === first.extent)
	const classes = new Set(same.map(classifyReading))

	if (classes.has(LayerReadingClass.Records) && classes.size > 1)
		return { class: LayerReadingClass.Conflicting, readings: same }

	return { class: classifyReading(first), readings: same }
}
