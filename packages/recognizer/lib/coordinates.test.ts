// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   One coordinate shape from text to a validated typed recognition and a trace,
 *   through the WebAssembly engine.
 *
 *   The engine's own behavior (spans, validators, replay) has its tests in the Rust crates.
 *   These tests hold the TypeScript boundary: UTF-16 spans, the typed result,
 *   the option that turns traces on, and the rule for trusting a recognition.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { coordinates } from "#coordinates"
import { isDeterministicCoordinate } from "#deterministic"
import { createRecognizer, type RecognizerResult, type TracedRecognizerResult } from "#index"
import { primitives } from "#primitives"
import { Outcome, type Trace, TraceResult } from "#runtime/trace"

const families = [primitives, coordinates] as const
const recognizer = createRecognizer(families)

function traceOf(result: { traces: readonly Trace[] }, shape: string): Trace {
	const found = result.traces.find((trace) => trace.shape === shape)

	if (!found) throw new Error(`no trace of ${shape}`)

	return found
}

describe("a coordinate from text to a validated typed recognition with a trace", () => {
	it("validates a decimal pair and traces every step", () => {
		const text = "40.7128, -74.0060"
		const result = recognizer.recognize(text, { trace: true })
		const pair = result.recognitions.find((recognition) => recognition.kind === "coordinate.decimal_pair")

		expect(pair).toMatchObject({ start: 0, end: text.length, text })

		expect(pair?.validation).toEqual({
			status: "validated",
			payload: { latitude: 40.7128, longitude: -74.006, order: "lat_lon" },
		})

		const trace = traceOf(result, "coordinate.decimal_pair")

		expect(result.traces).toHaveLength(result.recognitions.length)

		expect(trace).toMatchObject({
			family: "coordinates",
			span: { start: 0, end: text.length },
			result: TraceResult.Validated,
		})

		expect(trace.steps.map((step) => [step.node, step.outcome])).toEqual([
			["coordinate.decimal_pair#0", Outcome.Pass],
			["coordinate.decimal_pair#1", Outcome.Pass],
			["coordinate.decimal_pair#2", Outcome.Pass],
			["coordinate.decimal_pair#3", Outcome.Pass],
			["coordinate.decimal_pair#4", Outcome.Pass],
			["coordinate.decimal_pair#validator", Outcome.Pass],
		])

		expect(trace.steps[0]).toMatchObject({ op: "capture", name: "first" })
		expect(trace.steps[0]!.source.file).toMatch(/grammars\/coordinates\.rs$/u)
	})

	it("reports a validator rejection as a typed reason on the last step", () => {
		const result = recognizer.recognize("100, 200", { trace: true })
		const pair = result.recognitions.find((recognition) => recognition.kind === "coordinate.decimal_pair")

		expect(pair?.validation).toEqual({
			status: "rejected",
			rejection: expect.objectContaining({ code: "latitude_out_of_range", capture: "first" }),
		})

		const trace = traceOf(result, "coordinate.decimal_pair")
		const last = trace.steps.at(-1)

		expect(trace.result).toBe(TraceResult.Rejected)
		expect(last).toMatchObject({ node: "coordinate.decimal_pair#validator", outcome: Outcome.Rejected })
		expect(last?.rejection?.code).toBe("latitude_out_of_range")
	})

	it("explains a grammar rejection for a shape named in `explain`", () => {
		const text = "geo:1 2"
		const result = recognizer.recognize(text, { trace: { explain: ["coordinate.geo_uri"] } })

		expect(result.recognitions.some((recognition) => recognition.kind === "coordinate.geo_uri")).toBe(false)

		const trace = traceOf(result, "coordinate.geo_uri")

		expect(trace.result).toBe(TraceResult.NoMatch)
		expect(trace.span).toBeUndefined()

		const failing = trace.steps.find((step) => step.outcome === Outcome.Fail)

		// The scheme and the latitude are read, and the comma is missing.
		expect(failing).toMatchObject({ node: "coordinate.geo_uri#3", op: "literal", name: "," })
		expect(failing?.span).toEqual({ start: 5, end: 5 })
	})

	it("returns spans in UTF-16 code units, including inside a trace", () => {
		const text = "😀 40.5, -74.25 😀"
		const result = recognizer.recognize(text, { trace: true })
		const pair = result.recognitions.find((recognition) => recognition.kind === "coordinate.decimal_pair")

		expect(pair).toMatchObject({ start: 3, end: 15, text: "40.5, -74.25" })
		expect(text.slice(pair!.start, pair!.end)).toBe(pair!.text)

		const trace = traceOf(result, "coordinate.decimal_pair")

		expect(trace.span).toEqual({ start: 3, end: 15 })

		// Each step of an accepted parse tiles the span, in code units.
		const spans = trace.steps.flatMap((step) => (step.span ? [step.span] : []))

		expect(spans[0]!.start).toBe(3)
		expect(spans.at(-1)!.end).toBe(15)

		for (const span of spans) {
			expect(text.slice(span.start, span.end)).toHaveLength(span.end - span.start)
		}
	})

	it("survives a lone surrogate, which the engine reads as U+FFFD", () => {
		for (const text of ["\uD800 1, 2", "1, 2 \uDC00", "\uDBFF\uD800́ 5.5, 6.5"]) {
			const result = recognizer.recognize(text, { trace: { explain: ["coordinate.decimal_pair"] } })

			for (const recognition of result.recognitions) {
				expect(text.slice(recognition.start, recognition.end)).toBe(recognition.text)
			}

			for (const trace of result.traces) {
				for (const span of [trace.span, ...trace.steps.map((step) => step.span)]) {
					if (span) {
						expect(span.end).toBeLessThanOrEqual(text.length)
					}
				}
			}
		}
	})

	it("reads no coordinate in non-ASCII digits or in an address", () => {
		for (const text of ["٣, ٤", "１２, ３４", "350 5th Ave, New York, NY 10118", "12345 Main Street"]) {
			const { recognitions } = recognizer.recognize(text)

			expect(recognitions.some((recognition) => recognition.kind.startsWith("coordinate."))).toBe(false)
		}

		const { recognitions } = recognizer.recognize("12345 Main Street")

		expect(recognitions.find((recognition) => recognition.kind === "number.digit_run")).toMatchObject({
			start: 0,
			end: 5,
		})
	})

	it("returns the coordinate reading with its alternative readings", () => {
		const kinds = new Set(recognizer.recognize("12.5, 45.2").recognitions.map((recognition) => recognition.kind))

		expect(kinds).toEqual(
			new Set(["coordinate.decimal_pair", "number.signed_decimal", "number.digit_run", "space.whitespace"])
		)
	})
})

describe("traces are opt-in", () => {
	it("builds no trace and calls no trace export without the option", async () => {
		// The root Vitest configuration shares one module registry between test files (`isolate: false`),
		// so a hoisted mock is skipped whenever another file loaded the engine first.
		// This test loads its own copy of the modules behind a counting wrapper, and removes both afterwards.
		const traced = { calls: 0 }

		vi.resetModules()

		vi.doMock("#runtime/engine", async (importOriginal) => {
			const original = await importOriginal<typeof import("#runtime/engine")>()

			return {
				...original,
				traceText: (...parameters: Parameters<typeof original.traceText>) => {
					traced.calls++

					return original.traceText(...parameters)
				},
			}
		})

		try {
			const [fresh, freshPrimitives, freshCoordinates] = await Promise.all([
				import("#index"),
				import("#primitives"),
				import("#coordinates"),
			])

			const counted = fresh.createRecognizer([freshPrimitives.primitives, freshCoordinates.coordinates])

			for (const text of ["40.7128, -74.0060", "geo:1,2", "68161", ""]) {
				const result = counted.recognize(text)

				expect("traces" in result).toBe(false)
				expect(Object.keys(result).toSorted()).toEqual(["fields", "recognitions"])

				const off = counted.recognize(text, { trace: false })

				expect("traces" in off).toBe(false)
			}

			expect(traced.calls).toBe(0)

			counted.recognize("1, 2", { trace: true })

			expect(traced.calls).toBe(1)
		} finally {
			vi.doUnmock("#runtime/engine")
			vi.resetModules()
		}
	})

	it("keeps the type of a call without the option", () => {
		const plain = recognizer.recognize("1, 2")
		const optional = recognizer.recognize("1, 2", { trace: false })
		const asked = recognizer.recognize("1, 2", { trace: true })
		const options = recognizer.recognize("1, 2", { trace: { explain: [] } })

		expectTypeOf(plain).toEqualTypeOf<RecognizerResult<typeof families>>()
		expectTypeOf(optional).toEqualTypeOf<RecognizerResult<typeof families>>()
		expectTypeOf(asked).toEqualTypeOf<TracedRecognizerResult<typeof families>>()
		expectTypeOf(options.traces).toEqualTypeOf<readonly Trace[]>()
		// @ts-expect-error the default result has no traces
		void plain.traces
	})

	it("returns the same recognitions with and without traces", () => {
		for (const text of ["at 40.7128, -74.0060 now", "see geo:48.2,16.3;u=5 ok", "x"]) {
			expect(recognizer.recognize(text, { trace: true }).recognitions).toEqual(recognizer.recognize(text).recognitions)
		}
	})
})

describe("when a coordinate recognition may be trusted", () => {
	function decide(text: string): boolean[] {
		return recognizer
			.recognize(text)
			.recognitions.filter((recognition) => recognition.kind.startsWith("coordinate."))
			.map((recognition) => isDeterministicCoordinate(recognition, text))
	}

	it("trusts a validated recognition that covers the whole input", () => {
		expect(decide("40.7128, -74.0060")).toEqual([true])
		// The pair inside the URI is a second recognition, and only the whole URI covers the input.
		expect(decide("geo:40.7128,-74.0060").toSorted()).toEqual([false, true])
	})

	it("does not trust an embedded recognition, even a valid one", () => {
		expect(decide("Apt 4, 12 Main St")).toEqual([false])
		expect(decide("at 40.7128, -74.0060 now")).toEqual([false])
	})

	it("does not trust a rejected recognition that covers the whole input", () => {
		expect(decide("100, 200")).toEqual([false])
		expect(decide("geo:48.2,16.3;crs=Moon-2011")).toContain(false)
		expect(decide("geo:48.2,16.3;crs=Moon-2011")).not.toContain(true)
	})

	it("does not trust a recognition of another family", () => {
		const { recognitions } = recognizer.recognize("68161")

		expect(recognitions.some((recognition) => isDeterministicCoordinate(recognition, "68161"))).toBe(false)
	})

	it("narrows the recognition to a validated payload", () => {
		const text = "geo:48.2,16.3,100;u=3"

		for (const recognition of recognizer.recognize(text).recognitions) {
			if (isDeterministicCoordinate(recognition, text) && recognition.kind === "coordinate.geo_uri") {
				expect(recognition.validation.payload).toEqual({
					latitude: 48.2,
					longitude: 16.3,
					altitude: 100,
					uncertainty: 3,
				})
			}
		}
	})
})

describe("the other spellings of a point", () => {
	function reading(text: string, kind: string): unknown {
		const found = recognizer.recognize(text).recognitions.find((recognition) => recognition.kind === kind)

		return found?.validation.status === "validated" ? found.validation.payload : found?.validation
	}

	it("reads a decimal pair divided by white space, in whole-input scope only", () => {
		expect(reading("48.8584 2.2945", "coordinate.decimal_pair_spaced")).toEqual({
			latitude: 48.8584,
			longitude: 2.2945,
			order: "lat_lon",
		})

		// Without a decimal point the pair is a house number and a postcode, and embedded it is two adjacent numbers.
		expect(reading("12 34", "coordinate.decimal_pair_spaced")).toBeUndefined()
		expect(reading("350 5th Ave", "coordinate.decimal_pair_spaced")).toBeUndefined()
		expect(reading("Apt 4.5 12 Main St", "coordinate.decimal_pair_spaced")).toBeUndefined()
	})

	it("reads degrees, minutes, seconds and hemisphere letters", () => {
		expect(reading("2.2945E, 48.8584N", "coordinate.dms_pair")).toEqual({
			latitude: 48.8584,
			longitude: 2.2945,
			order: "lon_lat",
		})

		expect(reading("33° 51′ 54″ S 151° 12′ 36″ E", "coordinate.dms_pair_spaced")).toMatchObject({ order: "lat_lon" })
		expect(reading("12°, 5°", "coordinate.dms_pair")).toMatchObject({ latitude: 12, longitude: 5 })

		expect(reading("40N, 50N", "coordinate.dms_pair")).toMatchObject({
			status: "rejected",
			rejection: { code: "conflicting_hemispheres" },
		})
	})

	it("reads a labeled pair in either order and a Maps segment", () => {
		expect(reading("lng=2.2945, lat=48.8584", "coordinate.labeled_pair")).toEqual({
			latitude: 48.8584,
			longitude: 2.2945,
			order: "lon_lat",
		})

		expect(reading("lat 1 lat 2", "coordinate.labeled_pair")).toMatchObject({
			rejection: { code: "same_axis_labels" },
		})

		expect(reading("@48.8584,2.2945,17z", "coordinate.maps_segment")).toEqual({
			latitude: 48.8584,
			longitude: 2.2945,
			order: "lat_lon",
		})
	})
})
