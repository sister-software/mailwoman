// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import ts from "typescript"
import { describe, expect, it } from "vitest"

import { stateColumnWritesCheck, uncomparedStateWrites } from "#repo-health/checks/state-column-writes"
import { collectRepoContext } from "#repo-health/index"

function writesIn(text: string) {
	return uncomparedStateWrites(ts.createSourceFile("probe.ts", text, ts.ScriptTarget.Latest, true))
}

describe("uncomparedStateWrites", () => {
	it("reports a Kysely update of a state column that filters on the key alone", () => {
		expect(writesIn(`await db.updateTable("t").set({ email_state: to, note }).where("id", "=", id).execute()`)).toEqual(
			[{ line: 1, columns: ["email_state"] }]
		)
	})

	it("passes a Kysely update that compares a state column, with others inside a conditional spread", () => {
		expect(
			writesIn(
				`await db.updateTable("t").set({ license_state: to, ...(p ? { payment_state: p } : {}) })` +
					`.where("id", "=", id).where("license_state", "=", from).executeTakeFirst()`
			)
		).toEqual([])
	})

	it("reads an SQL update's SET and WHERE clauses, with substitutions in the template", () => {
		expect(writesIn("const q = `UPDATE t SET license_state = '${to}' WHERE lid = '${lid}'`")).toEqual([
			{ line: 1, columns: ["license_state"] },
		])

		expect(
			writesIn("const q = `UPDATE t SET license_state = '${to}' WHERE lid = '${lid}' AND license_state = '${from}'`")
		).toEqual([])
	})

	it("passes a set call outside an update chain and an update of other columns", () => {
		expect(writesIn(`cache.set({ email_state: "sent" })`)).toEqual([])
		expect(writesIn(`await db.updateTable("t").set({ updated_at: at }).where("id", "=", id).execute()`)).toEqual([])
	})
})

describe("stateColumnWritesCheck", () => {
	it("passes the current tree", async () => {
		await expect(stateColumnWritesCheck.run(await collectRepoContext())).resolves.toEqual([])
	})
})
