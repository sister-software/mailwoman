/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixtures for the ROAD_TO_V9 §4 intent vocabulary. Every kind is exercised in BOTH registers —
 *   as-written and lowercase — because lowercase is the primary user register and a rule that only
 *   works on title case is a rule that only works on our test data.
 */

import { computeQueryShape } from "@mailwoman/query-shape"
import { describe, expect, test } from "vitest"

import { classifyKindSync } from "./classify.ts"
import { scoreBareToponym, scoreNearMe, scoreRoutePair } from "./intent-rules.ts"
import type { NormalizedInputLite, QueryKind, QueryShapeLike } from "./types.ts"

function shapeOf(text: string): { input: NormalizedInputLite; shape: QueryShapeLike } {
	return { input: { raw: text, normalized: text }, shape: computeQueryShape(text) }
}

/**
 * Every kind present in a verdict — top plus alternatives. The two ranked-below-incumbent intent kinds live in
 * `alternatives` by design, so a test that only reads `.kind` cannot see them.
 */
function kindsOf(text: string): Set<QueryKind> {
	const { input, shape } = shapeOf(text)
	const verdict = classifyKindSync(input, shape)

	return new Set<QueryKind>([verdict.kind, ...verdict.alternatives.map((a) => a.kind)])
}

/**
 * Both registers of one query. Lowercase is not a variant here — it is the register most users type in.
 */
function registers(text: string): string[] {
	return text === text.toLowerCase() ? [text] : [text, text.toLowerCase()]
}

describe("bare_toponym — one place-name, no address grammar", () => {
	// The hard-slice board's `bare_namesake` class (fixtures/hard-slice-board.jsonl), which is the
	// population ROAD_TO_V9 §3 assembled for exactly this register.
	const POSITIVE = [
		"Fulda",
		"Jena",
		"Passau",
		"Speyer",
		"Trier",
		"Worms",
		"Bordeaux",
		"Springfield",
		"Paris",
		"Tokyo",
		"New York",
		"San Francisco",
		"Saint-Denis",
	]

	for (const query of POSITIVE) {
		for (const register of registers(query)) {
			test(`fires on ${JSON.stringify(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreBareToponym(input, shape)).toBeGreaterThan(0)
				expect(kindsOf(register).has("bare_toponym")).toBe(true)
			})
		}
	}

	const NEGATIVE = [
		"350 5th Ave, New York, NY 10118",
		"1600 Pennsylvania Ave NW, Washington, DC 20500",
		"10118",
		"PO Box 1234",
		"corner of 5th and Main",
		"12 rue de Rome Paris",
		// Admin context present — `locality_only` owns this, and a tail is exactly what makes it NOT bare.
		"Paris, FR",
		"Athens, OH",
	]

	for (const query of NEGATIVE) {
		for (const register of registers(query)) {
			test(`silent on ${JSON.stringify(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreBareToponym(input, shape)).toBe(0)
			})
		}
	}

	test("is a strict refinement of locality_only — it never takes the top slot from it", () => {
		for (const query of POSITIVE) {
			for (const register of registers(query)) {
				const { input, shape } = shapeOf(register)
				const verdict = classifyKindSync(input, shape)

				expect(verdict.kind, `${register} top kind`).not.toBe("bare_toponym")
			}
		}
	})
})

describe("route_pair — two toponyms, no grammar between them", () => {
	const POSITIVE = ["Paris London", "Tokyo Osaka", "Berlin Munich", "Bordeaux Lyon"]

	for (const query of POSITIVE) {
		for (const register of registers(query)) {
			test(`fires on ${JSON.stringify(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreRoutePair(input, shape)).toBeGreaterThan(0)
				expect(kindsOf(register).has("route_pair")).toBe(true)
			})
		}
	}

	const NEGATIVE = [
		// Toponymic HEAD particles: one place, two tokens. The class this guard exists for.
		"New York",
		"San Francisco",
		"Santa Monica",
		"Los Angeles",
		"Las Vegas",
		"Fort Worth",
		"Mount Vernon",
		"Port Elizabeth",
		"Lake Charles",
		"Saint Denis",
		// Address grammar of any kind disqualifies.
		"350 5th Ave, New York, NY 10118",
		"12 rue de Rome Paris",
		"10118",
		"Paris London Berlin",
		// A comma is the admin-context marker; the hard-slice `comma_control` register.
		"Athens, Georgia",
		"Portland, ME",
	]

	for (const query of NEGATIVE) {
		for (const register of registers(query)) {
			test(`silent on ${JSON.stringify(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreRoutePair(input, shape)).toBe(0)
			})
		}
	}

	test("never takes the top slot — a fork is declared, never routed", () => {
		for (const query of POSITIVE) {
			for (const register of registers(query)) {
				const { input, shape } = shapeOf(register)

				expect(classifyKindSync(input, shape).kind, `${register} top kind`).not.toBe("route_pair")
			}
		}
	})
})

describe("near_me — a relation to the asker, with the asker missing", () => {
	const POSITIVE = [
		"gas station near me",
		"restaurants nearby",
		"coffee near me",
		"pharmacy close to me",
		"atm around me",
		"hospitals near here",
		"parking near my location",
	]

	for (const query of POSITIVE) {
		for (const register of registers(query)) {
			test(`fires on ${JSON.stringify(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreNearMe(input, shape)).toBeGreaterThan(0)
				expect(classifyKindSync(input, shape).kind).toBe("near_me")
			})
		}
	}

	const NEGATIVE = [
		// An ANCHOR is present — this is answerable without a focus point, so it is not `near_me`.
		"gas station near Austin",
		"restaurants near Times Square",
		"coffee in Paris",
		"350 5th Ave, New York, NY 10118",
		"Paris",
		// The landmark leaders keep their own rule: a relative description of a REAL anchor.
		"near the Empire State Building",
	]

	for (const query of NEGATIVE) {
		for (const register of registers(query)) {
			test(`silent on ${JSON.stringify(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreNearMe(input, shape)).toBe(0)
			})
		}
	}
})
