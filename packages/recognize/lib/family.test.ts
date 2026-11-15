// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The handler map type covers the union of the composed families' kinds.
 *   The `@ts-expect-error` lines are the test: `yarn typecheck` fails when one of them stops being an error,
 *   so a handler map that omits a kind of a composed family must fail to type-check.
 */

import { describe, expect, expectTypeOf, it } from "vitest"

import { type CoordinateDecimalPairRejection, type CoordinatesKind, coordinates } from "#coordinates"
import type { Handler, HandlerMap, KindsOf } from "#family"
import { type PrimitivesKind, primitives } from "#primitives"
import type { AxisOrder, Validated } from "#types"

const families = [primitives, coordinates] as const

type Kinds = KindsOf<typeof families>

describe("the handler map type", () => {
	it("has one kind for every shape of every composed family", () => {
		expectTypeOf<Kinds>().toEqualTypeOf<PrimitivesKind | CoordinatesKind>()
		expectTypeOf<KindsOf<readonly [typeof coordinates]>>().toEqualTypeOf<CoordinatesKind>()
	})

	it("accepts a map that covers every kind", () => {
		const handlers = {
			"number.digit_run": () => "digits",
			"number.signed_decimal": () => "decimal",
			"space.whitespace": () => "space",
			"word.ascii": () => "word",
			"coordinate.decimal_pair": () => "pair",
			"coordinate.geo_uri": () => "uri",
		} satisfies { [K in Kinds]: Handler<K> }

		expect(Object.keys(handlers)).toHaveLength(6)
	})

	it("refuses a map that omits a kind of a composed family", () => {
		const missing = {
			"number.digit_run": () => "digits",
			"number.signed_decimal": () => "decimal",
			"space.whitespace": () => "space",
			"word.ascii": () => "word",
			// @ts-expect-error `coordinate.decimal_pair` has no handler
		} satisfies { [K in Kinds]: Handler<K> }

		const typed = {
			"number.digit_run": () => "digits",
			"number.signed_decimal": () => "decimal",
			"space.whitespace": () => "space",
			"word.ascii": () => "word",
			// @ts-expect-error `coordinate.decimal_pair` has no handler
		} satisfies HandlerMap<typeof families>

		expect(Object.keys(missing)).toEqual(Object.keys(typed))
	})

	it("refuses a handler for a kind no composed family declares", () => {
		const extra = {
			"number.digit_run": () => 1,
			"number.signed_decimal": () => 1,
			"space.whitespace": () => 1,
			"word.ascii": () => 1,
			"coordinate.decimal_pair": () => 1,
			"coordinate.geo_uri": () => 1,
			// @ts-expect-error `nope.nothing` is not a kind
			"nope.nothing": () => 1,
		} satisfies HandlerMap<typeof families>

		expect(Object.keys(extra)).toHaveLength(7)
	})

	it("types each handler's recognition with its own payload", () => {
		const handlers = {
			"number.digit_run": () => 0,
			"number.signed_decimal": () => 0,
			"space.whitespace": () => 0,
			"word.ascii": () => 0,
			"coordinate.decimal_pair": (recognition) => {
				expectTypeOf(recognition.kind).toEqualTypeOf<"coordinate.decimal_pair">()

				// @ts-expect-error a rejection carries no payload, so the payload is read after narrowing
				const unnarrowed: unknown = recognition.validation.payload

				expect(unnarrowed).toBeUndefined()

				if (recognition.validation.status === "validated") {
					expectTypeOf(recognition.validation.payload.latitude).toEqualTypeOf<Validated.Latitude>()
					expectTypeOf(recognition.validation.payload.order).toEqualTypeOf<AxisOrder>()

					// @ts-expect-error a validated latitude is branded, so a plain number is refused
					const plain: Validated.Latitude = 40.5

					// @ts-expect-error a longitude is not a latitude
					const swapped: Validated.Latitude = recognition.validation.payload.longitude

					return plain + swapped
				}

				if (recognition.validation.status === "rejected") {
					// The codes are the closed union the validator and the engine return.
					expectTypeOf(recognition.validation.rejection.code).toEqualTypeOf<CoordinateDecimalPairRejection>()

					switch (recognition.validation.rejection.code) {
						case "latitude_out_of_range":
						case "longitude_out_of_range":
						case "missing_capture":
						case "not_a_decimal":
						case "not_finite":
						case "capture_limit":
						case "capture_mismatch":
							return 1
						default: {
							// An unlisted code would leave a value here, and `never` refuses it.
							const exhausted: never = recognition.validation.rejection.code

							return exhausted
						}
					}
				}

				return 0
			},
			"coordinate.geo_uri": (recognition) => {
				if (recognition.validation.status === "validated") {
					expectTypeOf(recognition.validation.payload.altitude).toEqualTypeOf<Validated.Decimal | undefined>()
				}

				return 0
			},
		} satisfies HandlerMap<typeof families>

		expect(Object.keys(handlers)).toHaveLength(6)
	})

	it("types a shape-only kind with its span and text only", () => {
		const handler: HandlerMap<typeof families>["word.ascii"] = (recognition) => {
			expectTypeOf(recognition.validation).toEqualTypeOf<{ readonly status: "unvalidated" }>()

			return recognition.text
		}

		expect(typeof handler).toBe("function")
	})
})
