/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { entityIndex } from "#entities"
import { buildingsOn, entrancesOf, resolveAlias } from "#links"
import { sourceIndex } from "#sources"
import {
	ALIASES,
	ANNEX,
	CONTAINMENT,
	ENTITIES,
	HOUSE,
	NORTH,
	PARCEL,
	SOURCES,
	SOUTH,
} from "#test/fixtures/example-house"

describe("two frontages", () => {
	test("both aliases resolve to distinct entrances of one building, each with its evidence", () => {
		const resolved = ALIASES.map(resolveAlias)

		expect(resolved).toEqual([
			{ kind: "resolved", entity: NORTH, evidence: { source: "survey-2022", observedAt: "2022-03-15" } },
			{ kind: "resolved", entity: SOUTH, evidence: { source: "survey-2022", observedAt: "2022-03-15" } },
		])

		expect(entrancesOf(HOUSE, CONTAINMENT).map((link) => link.child)).toEqual([NORTH, SOUTH])

		expect(ALIASES.map((alias) => alias.text)).toEqual([
			"North entrance, Example House",
			"South entrance, Example House",
		])
	})

	test("an alias with two candidates is ambiguous and keeps both", () => {
		const alias = { text: "Example House", candidates: [...ALIASES[0]!.candidates, ...ALIASES[1]!.candidates] }

		expect(resolveAlias(alias)).toEqual({ kind: "ambiguous", candidates: alias.candidates })
	})

	test("an alias with no candidate is unlinked", () => {
		expect(resolveAlias({ text: "Nowhere House", candidates: [] })).toEqual({ kind: "unlinked" })
	})
})

describe("shared parcel", () => {
	test("two buildings stand on the parcel and each keeps its identity", () => {
		expect(buildingsOn(PARCEL, CONTAINMENT).map((link) => link.child)).toEqual([HOUSE, ANNEX])

		expect(entityIndex(ENTITIES).get(ANNEX)?.externalIDs).toEqual([
			{ namespace: "example:bin", value: "1002", evidence: { source: "permit-2021", observedAt: "2021-05-10" } },
		])
	})
})

describe("indexes", () => {
	test("refuse a duplicate id", () => {
		expect(() => sourceIndex([...SOURCES, SOURCES[0]!])).toThrow(/duplicate source id permit-2021/)
		expect(() => entityIndex([...ENTITIES, ENTITIES[1]!])).toThrow(/duplicate entity id building:example-house/)
	})
})
