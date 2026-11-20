// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { EMPTY_QUERY_SHAPE_VIEW, type QueryShapeFormatsView as QueryShapeLike } from "@mailwoman/core/pipeline/types"
import { expect, test } from "vitest"

import { scoreByPostcode, scoreByScript } from "#rules"

const fmt = (format: string, confidence = 0.9, start = 0, end = 5) => ({
	format,
	span: { start, end },
	confidence,
})

const shape = (o: Partial<QueryShapeLike> = {}): QueryShapeLike => ({ ...EMPTY_QUERY_SHAPE_VIEW, ...o })

test("scoreByScript: Latin script classes commit nothing (other scorers decide)", () => {
	expect(scoreByScript(shape({ characterClass: "alpha" }))).toBeNull()
	expect(scoreByScript(shape({ characterClass: "alphanumeric" }))).toBeNull()
	expect(scoreByScript(shape({ characterClass: "numeric" }))).toBeNull()
	expect(scoreByScript(shape())).toBeNull()
})

test("scoreByPostcode: an unambiguous high-confidence hit maps to its implied country", () => {
	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("us_zip4", 0.95)] }))).toEqual({
		locale: "en-US",
		confidence: 0.95,
		reason: "format=us_zip4",
	})

	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("uk_postcode", 0.95)] }))).toEqual({
		locale: "en-GB",
		confidence: 0.95,
		reason: "format=uk_postcode",
	})

	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("jp_postcode", 0.9)] }))).toEqual({
		locale: "ja-JP",
		confidence: 0.95,
		reason: "format=jp_postcode",
	})
})

test("scoreByPostcode: Canadian postcode defaults to en-CA at 0.9 (FR caller can override)", () => {
	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("ca_postcode", 0.92)] }))).toEqual({
		locale: "en-CA",
		confidence: 0.9,
		reason: "format=ca_postcode",
	})
})

test("scoreByPostcode: confidence boundary — exactly 0.9 counts as unambiguous", () => {
	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("us_zip4", 0.9)] }))).toEqual({
		locale: "en-US",
		confidence: 0.95,
		reason: "format=us_zip4",
	})

	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("us_zip4", 0.89)] }))).toBeNull()
})

test("scoreByPostcode: an unrecognized high-confidence format yields null (switch has no default)", () => {
	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("de_postcode", 0.95)] }))).toBeNull()
})

test("scoreByPostcode: ambiguous 5-digit (us_zip / fr_postcode) falls back to low-confidence US", () => {
	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("us_zip", 0.6)] }))).toEqual({
		locale: "en-US",
		confidence: 0.5,
		reason: "ambiguous-5digit-postcode",
	})

	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("fr_postcode", 0.6)] }))).toEqual({
		locale: "en-US",
		confidence: 0.5,
		reason: "ambiguous-5digit-postcode",
	})
})

test("scoreByPostcode: no postcode hit at all → null", () => {
	expect(scoreByPostcode(shape())).toBeNull()
	expect(scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("po_box", 0.95)] }))).toBeNull()
})

test("scoreByPostcode: unambiguous hit wins over a co-present ambiguous 5-digit", () => {
	expect(
		scoreByPostcode(shape({ ...EMPTY_QUERY_SHAPE_VIEW, knownFormats: [fmt("us_zip", 0.6), fmt("us_zip4", 0.95)] }))
	).toEqual({
		locale: "en-US",
		confidence: 0.95,
		reason: "format=us_zip4",
	})
})

test("scoreByPostcode: the postal generation reads the locale and the confidence of the best postcode hit", () => {
	const hit = (confidence: number, locale: string | null, form: "alnum" | "numeric" | "designated") => ({
		...fmt("postcode", confidence),
		locale,
		form,
	})

	const postal = (knownFormats: QueryShapeLike["knownFormats"]) =>
		scoreByPostcode(shape({ generation: "postal", knownFormats }))

	expect(postal([hit(0.55, "en-US", "numeric"), hit(0.95, "en-GB", "alnum")])).toEqual({
		locale: "en-GB",
		confidence: 0.95,
		reason: "postcode form=alnum",
	})

	expect(postal([hit(0.55, "en-US", "numeric")])).toMatchObject({ locale: "en-US", confidence: 0.55 })
	expect(postal([{ ...fmt("po_box", 0.85), locale: null }])).toBeNull()
	expect(postal([])).toBeNull()
})
