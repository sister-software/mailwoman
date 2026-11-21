// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The per-country validation quota: lowest group hash first, until the target or the cap.
 */

import { describe, expect, it } from "vitest"

import { hashUint32 } from "#utils/split"
import {
	evaluationGroupPolicy,
	selectValidationGroups,
	type ValidationCandidate,
	validationTarget,
} from "#utils/validation-groups"

const quota = { margin: 2, minimumRows: 4, capRows: 10 }

const pool = (country: string, count: number, rows = 1, streetRows = rows): ValidationCandidate[] =>
	Array.from({ length: count }, (_, index) => ({ country, group: `${country}-${index}`, rows, streetRows }))

describe("validationTarget", () => {
	it("doubles a floor, raises it to the minimum and caps it", () => {
		expect(validationTarget({ minRows: 3, minStreetRows: 1 }, quota)).toEqual({ rows: 6, streetRows: 2 })
		expect(validationTarget({ minRows: 1, minStreetRows: 0 }, quota)).toEqual({ rows: 4, streetRows: 0 })
		expect(validationTarget({ minRows: 100, minStreetRows: 100 }, quota)).toEqual({ rows: 10, streetRows: 10 })
		expect(validationTarget(undefined, quota)).toEqual({ rows: 4, streetRows: 0 })
	})
})

describe("selectValidationGroups", () => {
	const target = (country: string) => (country === "GB" ? { rows: 6, streetRows: 6 } : { rows: 4, streetRows: 0 })

	it("takes each country's lowest-hash groups until the target", () => {
		const candidates = pool("FR", 20)
		const { groups, countries } = selectValidationGroups(candidates, target, quota)

		const expected = candidates
			.map((candidate) => candidate.group)
			.toSorted((a, b) => hashUint32(a) - hashUint32(b))
			.slice(0, 4)

		expect(groups).toEqual(expected.toSorted())
		expect(countries.FR).toMatchObject({ rows: 4, groups: 4, poolRows: 20, poolGroups: 20, exhausted: false })
	})

	it("decides the same groups whatever order the candidates arrive in", () => {
		const candidates = [...pool("FR", 20), ...pool("GB", 20)]

		expect(selectValidationGroups(candidates.toReversed(), target, quota)).toEqual(
			selectValidationGroups(candidates, target, quota)
		)
	})

	it("keeps taking groups until the street target is met too", () => {
		const candidates = [...pool("GB", 30, 1, 0), { country: "GB", group: "GB-street", rows: 1, streetRows: 1 }]
		const { countries } = selectValidationGroups(candidates, target, quota)

		// Six rows meet the row target, but the pool holds one street row, so only the cap stops the walk.
		expect(countries.GB).toMatchObject({ rows: quota.capRows, exhausted: false })
	})

	it("keeps a pool smaller than its target and reports it exhausted", () => {
		const { countries } = selectValidationGroups(pool("NG", 3), target, quota)

		expect(countries.NG).toMatchObject({ rows: 3, groups: 3, exhausted: true })
	})

	it("stops at the cap", () => {
		const { countries } = selectValidationGroups(pool("US", 100), () => ({ rows: 1000, streetRows: 0 }), quota)

		expect(countries.US).toMatchObject({ rows: quota.capRows, exhausted: false })
	})
})

describe("evaluationGroupPolicy", () => {
	const frozen = {
		path: "frozen.json",
		sha256: "f".repeat(64),
		datasets: [],
		groups: new Set(["a"]),
		addressKeys: new Set<string>(),
	}

	const validation = (groups: string[], against = frozen.sha256) => ({
		path: "validation.json",
		sha256: "v".repeat(64),
		quota,
		evaluationGroupsSHA256: against,
		groups: new Set(groups),
	})

	it("refuses a validation list that holds a frozen group, since the overlap audit reads val as training", () => {
		expect(() => evaluationGroupPolicy(frozen, validation(["a"]))).toThrow(/lists frozen group a/u)
	})

	it("refuses a validation list drawn against another frozen list", () => {
		expect(() => evaluationGroupPolicy(frozen, validation(["b"], "0".repeat(64)))).toThrow(/drawn against frozen list/u)
		expect(evaluationGroupPolicy(frozen, validation(["b"])).validation.groups.has("b")).toBe(true)
	})
})
