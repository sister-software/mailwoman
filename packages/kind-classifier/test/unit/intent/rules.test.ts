import { stringifyJSON } from "@mailwoman/core/json"
import type { QueryKind } from "@mailwoman/core/pipeline"
import { classifyKindSync } from "@mailwoman/kind-classifier/classify"
import { scoreBareToponym, scoreNearMe, scoreRoutePair } from "@mailwoman/kind-classifier/intent-rules"
import {
	computeQueryShape,
	type NormalizedInputLite,
	type QueryShapeSegmentsView as QueryShapeLike,
} from "@mailwoman/query-shape"
import { describe, expect, test } from "vitest"

function shapeOf(text: string): { input: NormalizedInputLite; shape: QueryShapeLike } {
	return { input: { raw: text, normalized: text }, shape: computeQueryShape(text) }
}

function kindsOf(text: string): Set<QueryKind> {
	const { input, shape } = shapeOf(text)
	const verdict = classifyKindSync(input, shape)

	return new Set<QueryKind>([verdict.kind, ...verdict.alternatives.map((a) => a.kind)])
}

function registers(text: string): string[] {
	return text === text.toLowerCase() ? [text] : [text, text.toLowerCase()]
}

describe("Bare_toponym — one place-name without address grammar", () => {
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
			test(`fires for ${stringifyJSON(register)}`, () => {
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

		"Paris, FR",
		"Athens, OH",
	]

	for (const query of NEGATIVE) {
		for (const register of registers(query)) {
			test(`does not fire for ${stringifyJSON(register)}`, () => {
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

describe("Route_pair — two toponyms without grammar between them", () => {
	const POSITIVE = ["Paris London", "Tokyo Osaka", "Berlin Munich", "Bordeaux Lyon"]

	for (const query of POSITIVE) {
		for (const register of registers(query)) {
			test(`fires for ${stringifyJSON(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreRoutePair(input, shape)).toBeGreaterThan(0)
				expect(kindsOf(register).has("route_pair")).toBe(true)
			})
		}
	}

	const NEGATIVE = [
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

		"350 5th Ave, New York, NY 10118",
		"12 rue de Rome Paris",
		"10118",
		"Paris London Berlin",

		"Athens, Georgia",
		"Portland, ME",
	]

	for (const query of NEGATIVE) {
		for (const register of registers(query)) {
			test(`does not fire for ${stringifyJSON(register)}`, () => {
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
			test(`fires for ${stringifyJSON(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreNearMe(input, shape)).toBeGreaterThan(0)
				expect(classifyKindSync(input, shape).kind).toBe("near_me")
			})
		}
	}

	const NEGATIVE = [
		"gas station near Austin",
		"restaurants near Times Square",
		"coffee in Paris",
		"350 5th Ave, New York, NY 10118",
		"Paris",

		"near the Empire State Building",
	]

	for (const query of NEGATIVE) {
		for (const register of registers(query)) {
			test(`does not fire for ${stringifyJSON(register)}`, () => {
				const { input, shape } = shapeOf(register)

				expect(scoreNearMe(input, shape)).toBe(0)
			})
		}
	}
})
