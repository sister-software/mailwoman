// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { createEvaluationCorpusAdapter, EvaluationAdapterRefusal } from "#evaluation/corpus-adapter"
import type { EvaluationRecordReading } from "#evaluation/source"
import { AddressRole, type CanonicalRow } from "#types"

const record = (id: string): EvaluationRecordReading => ({
	id,
	stratum: "postcode 4",
	components: { house_number: "72", street: "Racecourse Road", locality: "Waipukurau", postcode: "4200" },
})

const adapter = createEvaluationCorpusAdapter({
	id: "nz-test-register",
	source: { id: "nz-test-register", country: "NZ", license: "Creative Commons Attribution 3.0 New Zealand" },
	register: "nz-test-register",
	locale: "en-NZ",
	addressRole: AddressRole.RegisteredOffice,
	description: "test",
	async *read() {
		yield record("CC1")
		yield { refused: "row:post-box" }
		// A second charity at the first one's address.
		yield record("CC2")
	},
})

describe("createEvaluationCorpusAdapter", () => {
	it("emits one row per address, counting the reader's refusals and the repeated address", async () => {
		const dropped = new Map<string, number>()
		const rows: CanonicalRow[] = []

		for await (const row of adapter.rows({ inputPath: "unused", dropped })) {
			rows.push(row)
		}

		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ country: "NZ", locale: "en-NZ", source: "nz-test-register" })
		expect(rows[0]!.raw).toContain("72 Racecourse Road")
		expect(Object.fromEntries(dropped)).toEqual({ "row:post-box": 1, [EvaluationAdapterRefusal.Duplicate]: 1 })
	})

	it("refuses a country filter other than the source's", async () => {
		await expect(adapter.rows({ inputPath: "unused", country: "AU" })[Symbol.asyncIterator]().next()).rejects.toThrow(
			/nz-test-register/u
		)
	})
})
