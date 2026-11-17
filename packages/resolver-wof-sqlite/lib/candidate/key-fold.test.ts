// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { applyCandidateKeyFold, CandidateKeyFold, candidateQueryKeyFold } from "#candidate/key-fold"
import { type CandidateDatabase, createCandidateTable } from "#candidate/schema"
import { type NameKey, normalizeLocalityForKey } from "#street/normalize"

async function candidateDatabase(
	rows: Array<[key: string, sprID: number]>
): Promise<DatabaseClient<CandidateDatabase>> {
	const db = DatabaseClient.temp<CandidateDatabase>()

	await createCandidateTable(db)

	const insert = db.prepare(
		"INSERT INTO candidate (name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name, is_primary) " +
			"VALUES (?, 1, 0, 3, -1, ?, ?, 1)"
	)

	for (const [key, sprID] of rows) {
		insert.run(key, sprID, key)
	}

	return db
}

function keys(db: DatabaseClient<CandidateDatabase>): string[] {
	return (db.prepare("SELECT name_key, spr_id FROM candidate ORDER BY spr_id, name_key").all() as never[]).map(
		(row: { name_key: string; spr_id: number }) => `${row.spr_id}:${row.name_key}`
	)
}

describe("applyCandidateKeyFold", () => {
	it("rekeys the Arabic variants, merges a place's duplicate, and leaves other scripts alone", async () => {
		const hamza = normalizeLocalityForKey("الإسماعيلية")
		const bare = normalizeLocalityForKey("الاسماعيليه")

		using db = await candidateDatabase([
			[hamza, 1],
			[bare, 1],
			[normalizeLocalityForKey("الوادى الجديد"), 2],
			["cairo", 3],
		])

		const result = await applyCandidateKeyFold(db, CandidateKeyFold.ArabicLetterVariants)

		expect(result).toEqual({ rekeyed: 2, merged: 1 })
		expect(keys(db)).toEqual(["1:الاسماعيليه", "2:الوادي الجديد", "3:cairo"])
	})

	it("records the fold, and the reader folds query keys only for an artifact that records it", async () => {
		using plain = await candidateDatabase([["cairo", 1]])
		using folded = await candidateDatabase([["cairo", 1]])

		await applyCandidateKeyFold(folded, CandidateKeyFold.ArabicLetterVariants)

		const query = normalizeLocalityForKey("الإسماعيلية") as NameKey

		expect(candidateQueryKeyFold(plain)(query)).toBe(query)
		expect(candidateQueryKeyFold(folded)(query)).toBe("الاسماعيليه")
	})
})
