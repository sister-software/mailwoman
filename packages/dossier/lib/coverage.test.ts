/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { classifyReading, classifyReadings, LayerReadingClass } from "#coverage"
import {
	MISSING_READING,
	POSITIVE_READING,
	SOURCE_PRESENT_EMPTY_READING,
	SURVEYED_EMPTY_READING,
} from "#test/fixtures/example-house"

describe("missing and empty coverage", () => {
	test("a layer with no survey is unknown", () => {
		expect(classifyReading(MISSING_READING)).toBe(LayerReadingClass.Unknown)
	})

	test("zero records in a surveyed layer is surveyed empty", () => {
		expect(classifyReading(SURVEYED_EMPTY_READING)).toBe(LayerReadingClass.SurveyedEmpty)
	})

	test("zero records in a source-present layer supports no exclusion", () => {
		expect(classifyReading(SOURCE_PRESENT_EMPTY_READING)).toBe(LayerReadingClass.SourcePresentEmpty)
	})

	test("a positive reading beside an empty one on the same layer and extent is conflicting", () => {
		expect(classifyReadings([SURVEYED_EMPTY_READING, POSITIVE_READING])).toEqual({
			class: LayerReadingClass.Conflicting,
			readings: [SURVEYED_EMPTY_READING, POSITIVE_READING],
		})
	})

	test("readings on different layers are classified separately", () => {
		expect(classifyReadings([MISSING_READING, SURVEYED_EMPTY_READING]).class).toBe(LayerReadingClass.Unknown)
	})
})
