// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The outcome request against the data root's `candidate.db`.
 *
 *   That build holds `outcome_default` and `record_outcome`, and the suite skips on a host without it.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { OUTCOME_KINDS } from "@mailwoman/core/outcome/kinds"
import type { OutcomeMembership } from "@mailwoman/core/resolver/outcome"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { afterAll, describe, expect, test } from "vitest"

import { resolveOutcomeFor } from "#geocode/result/outcome"

const CANDIDATE_DB = wofDatabasePath("candidate.db")
const haveDatabase = await pathExists(CANDIDATE_DB)

/**
 * Who's On First's Manhattan borough, and the Portland neighborhood `Mt. Tabor`.
 */
const MANHATTAN_BOROUGH = 421_205_771
const MT_TABOR_PORTLAND = 85_893_211

describe.skipIf(!haveDatabase)("outcome kinds over the data root's candidate.db", () => {
	const lookup = haveDatabase ? new WOFCandidateTableLookup({ databasePath: CANDIDATE_DB }) : null

	afterAll(() => lookup?.[Symbol.dispose]())

	test("the build holds both outcome tables", () => {
		expect(lookup!.missingOutcomeTables()).toEqual([])
	})

	test("a filter is a predicate of the fetch: every row read satisfies it", async () => {
		const rows = await lookup!.findPlace({
			text: "Manhattan",
			placetype: "locality",
			limit: 20,
			outcome: { admit: [OUTCOME_KINDS["place.borough"].id] },
		})

		expect(rows.map((row) => row.id)).toContain(MANHATTAN_BOROUGH)

		for (const row of rows) {
			expect(row.outcomes?.map((m) => m.outcome)).toContain("place.borough")
		}
	})

	test("a record with zero assertions holds exactly its placetype default", async () => {
		const rows = await lookup!.findPlace({ text: "Mt. Tabor", placetype: "neighbourhood", outcome: { admit: null } })
		const hood = rows.find((row) => row.id === MT_TABOR_PORTLAND)

		expect(hood?.outcomes).toEqual([
			{ outcome: "place.neighbourhood", contested: false, sources: ["candidate:default"] },
		])
	})

	test("the resolver answers a bare name from the rows the filter admits", async () => {
		const node: AddressNode = { tag: "locality", value: "Manhattan", start: 0, end: 9, confidence: 0.9, children: [] }
		const tree: AddressTree = { raw: "Manhattan", roots: [node] }

		const outcome = resolveOutcomeFor(
			{ outcomeFilter: ["place.borough"] },
			{ headOrder: null, headOrdering: false },
			{ kind: "bare_toponym", interpretedSpan: false }
		)

		const resolved = await createWOFResolver(lookup!).resolveTree(tree, { outcome })
		const answer = resolved.roots[0]!

		expect(answer.placeID).toBe(`wof:${MANHATTAN_BOROUGH}`)
		const members = (answer.metadata?.["outcomes"] ?? []) as OutcomeMembership[]

		expect(members.map((m) => m.outcome)).toContain("place.borough")
	})

	test("a resolve without outcome options reads no outcome sets", async () => {
		const rows = await lookup!.findPlace({ text: "Manhattan", placetype: "locality" })

		expect(rows.every((row) => row.outcomes === undefined)).toBe(true)
	})
})
