/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { scoreByPostcode, scoreByScript, scoreFallback } from "./rules.js"
import type { QueryShapeLike } from "./types.js"

const fmt = (format: string, confidence = 0.9, start = 0, end = 5) => ({
	format,
	span: { start, end },
	confidence,
})
const shape = (o: Partial<QueryShapeLike> = {}): QueryShapeLike => ({ knownFormats: [], ...o })

test("scoreByScript: each non-Latin script maps to its default locale", () => {
	expect(scoreByScript(shape({ characterClass: "cjk" }))).toEqual({
		locale: "ja-JP",
		confidence: 0.8,
		reason: "characterClass=cjk",
	})
	expect(scoreByScript(shape({ characterClass: "cyrillic" }))).toEqual({
		locale: "ru-RU",
		confidence: 0.85,
		reason: "characterClass=cyrillic",
	})
	expect(scoreByScript(shape({ characterClass: "arabic" }))).toEqual({
		locale: "ar",
		confidence: 0.85,
		reason: "characterClass=arabic",
	})
})

test("scoreByScript: Latin script classes commit nothing (other scorers decide)", () => {
	expect(scoreByScript(shape({ characterClass: "alpha" }))).toBeNull()
	expect(scoreByScript(shape({ characterClass: "alphanumeric" }))).toBeNull()
	expect(scoreByScript(shape({ characterClass: "numeric" }))).toBeNull()
	// Missing characterClass also yields no commit.
	expect(scoreByScript(shape())).toBeNull()
})

test("scoreByPostcode: an unambiguous high-confidence hit maps to its implied country", () => {
	expect(scoreByPostcode(shape({ knownFormats: [fmt("us_zip4", 0.95)] }))).toEqual({
		locale: "en-US",
		confidence: 0.95,
		reason: "format=us_zip4",
	})
	expect(scoreByPostcode(shape({ knownFormats: [fmt("uk_postcode", 0.95)] }))).toEqual({
		locale: "en-GB",
		confidence: 0.95,
		reason: "format=uk_postcode",
	})
	expect(scoreByPostcode(shape({ knownFormats: [fmt("jp_postcode", 0.9)] }))).toEqual({
		locale: "ja-JP",
		confidence: 0.95,
		reason: "format=jp_postcode",
	})
})

test("scoreByPostcode: Canadian postcode defaults to en-CA at 0.9 (FR caller can override)", () => {
	expect(scoreByPostcode(shape({ knownFormats: [fmt("ca_postcode", 0.92)] }))).toEqual({
		locale: "en-CA",
		confidence: 0.9,
		reason: "format=ca_postcode",
	})
})

test("scoreByPostcode: confidence boundary — exactly 0.9 counts as unambiguous", () => {
	// The filter is `>= 0.9`. A hit at exactly 0.9 must be treated as unambiguous.
	expect(scoreByPostcode(shape({ knownFormats: [fmt("us_zip4", 0.9)] }))).toEqual({
		locale: "en-US",
		confidence: 0.95,
		reason: "format=us_zip4",
	})
	// Just below the boundary: not unambiguous. `us_zip4` is not in the ambiguous-5digit fallback set,
	// so nothing fires.
	expect(scoreByPostcode(shape({ knownFormats: [fmt("us_zip4", 0.89)] }))).toBeNull()
})

test("scoreByPostcode: an unrecognized high-confidence format yields null (switch has no default)", () => {
	expect(scoreByPostcode(shape({ knownFormats: [fmt("de_postcode", 0.95)] }))).toBeNull()
})

test("scoreByPostcode: ambiguous 5-digit (us_zip / fr_postcode) falls back to low-confidence US", () => {
	expect(scoreByPostcode(shape({ knownFormats: [fmt("us_zip", 0.6)] }))).toEqual({
		locale: "en-US",
		confidence: 0.5,
		reason: "ambiguous-5digit-postcode",
	})
	expect(scoreByPostcode(shape({ knownFormats: [fmt("fr_postcode", 0.6)] }))).toEqual({
		locale: "en-US",
		confidence: 0.5,
		reason: "ambiguous-5digit-postcode",
	})
})

test("scoreByPostcode: no postcode hit at all → null", () => {
	expect(scoreByPostcode(shape())).toBeNull()
	// A non-postcode known format (e.g. po_box) is neither unambiguous-mapped nor 5-digit-ambiguous.
	expect(scoreByPostcode(shape({ knownFormats: [fmt("po_box", 0.95)] }))).toBeNull()
})

test("scoreByPostcode: unambiguous hit wins over a co-present ambiguous 5-digit", () => {
	// us_zip4@0.95 (unambiguous) and us_zip@0.6 (ambiguous) both present — the unambiguous branch
	// runs first, so we get the strong en-US, not the 0.5 fallback.
	expect(scoreByPostcode(shape({ knownFormats: [fmt("us_zip", 0.6), fmt("us_zip4", 0.95)] }))).toEqual({
		locale: "en-US",
		confidence: 0.95,
		reason: "format=us_zip4",
	})
})

test("scoreFallback: always en-US at low confidence (gate is never null)", () => {
	expect(scoreFallback(shape())).toEqual({ locale: "en-US", confidence: 0.3, reason: "fallback" })
	// Shape contents are ignored — it's the always-decisive whole-input fallback.
	expect(scoreFallback(shape({ characterClass: "cjk", knownFormats: [fmt("jp_postcode", 0.95)] }))).toEqual({
		locale: "en-US",
		confidence: 0.3,
		reason: "fallback",
	})
})
