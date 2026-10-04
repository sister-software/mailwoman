/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { classifyReading, classifyReadings, type LayerReading, LayerReadingClass } from "#coverage"

const evidence = { source: "survey-2022" }

describe("missing and empty coverage", () => {
	const missing: LayerReading = { layer: "ducts", extent: "cell-1", basis: null, records: null, evidence }

	const surveyedEmpty: LayerReading = {
		layer: "cabinets",
		extent: "cell-1",
		basis: "surveyed",
		surveyedAt: "2022-03-15",
		records: 0,
		evidence,
	}

	const sourcePresentEmpty: LayerReading = {
		layer: "poles",
		extent: "cell-1",
		basis: "source_present",
		records: 0,
		evidence,
	}

	const positive: LayerReading = {
		layer: "cabinets",
		extent: "cell-1",
		basis: "source_present",
		records: 1,
		evidence: { source: "undated-listing" },
	}

	test("a layer with no survey is unknown", () => {
		expect(classifyReading(missing)).toBe(LayerReadingClass.Unknown)
	})

	test("zero records in a surveyed layer is surveyed empty", () => {
		expect(classifyReading(surveyedEmpty)).toBe(LayerReadingClass.SurveyedEmpty)
	})

	test("zero records in a source-present layer supports no exclusion", () => {
		expect(classifyReading(sourcePresentEmpty)).toBe(LayerReadingClass.SourcePresentEmpty)
	})

	test("a positive reading beside an empty one on the same layer and extent is conflicting", () => {
		expect(classifyReadings([surveyedEmpty, positive])).toEqual({
			class: LayerReadingClass.Conflicting,
			readings: [surveyedEmpty, positive],
		})
	})

	test("readings on different layers are classified separately", () => {
		expect(classifyReadings([missing, surveyedEmpty]).class).toBe(LayerReadingClass.Unknown)
	})
})
