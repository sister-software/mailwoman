// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { LEGACY_FORMATS, PO_BOX_LEADERS } from "#legacy-formats/table"
import { DEFINITION_FILE, legacyDefinition } from "#tools/legacy-definition"

describe("the postcode_legacy definition", () => {
	it("states the order of the table as data, one explicit order for each format shape", () => {
		const { shapes } = legacyDefinition()
		const formats = shapes.filter(({ role }) => !role)

		expect(formats.map(({ order }) => order)).toEqual(LEGACY_FORMATS.map((_, index) => index))
		expect(formats.map(({ metadata }) => metadata.format)).toEqual(LEGACY_FORMATS.map(({ format }) => format))
		expect(new Set(formats.map(({ id }) => id)).size).toBe(LEGACY_FORMATS.length)
	})

	it("marks every PO box leader shape with a role, and no ID carries the meaning", () => {
		const { shapes } = legacyDefinition()
		const leaders = shapes.filter(({ role }) => role === "po_box_leader")

		expect(leaders.map(({ metadata }) => metadata.language)).toEqual(PO_BOX_LEADERS.map(({ language }) => language))
		expect(leaders.every(({ order }) => order === undefined)).toBe(true)
		expect(shapes.filter(({ role }) => role && role !== "po_box_leader")).toEqual([])
		expect(shapes.some(({ id }) => id.startsWith("leader.") || /_\d\d_/u.test(id))).toBe(false)
	})

	it("equals the committed definition, so a change to the table needs a regenerated family", async () => {
		const committed = await readLocalJSONFile<unknown>(
			workspacePath("postcode", "data", "definitions", DEFINITION_FILE).toString()
		)

		expect(committed).toEqual(legacyDefinition())
	})
})
