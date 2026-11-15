// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { LEGACY_FORMATS } from "#legacy-formats/table"
import { DEFINITION_FILE, legacyDefinition } from "#tools/legacy-definition"

describe("the postcode_legacy definition", () => {
	it("sorts the format shapes in the order of the table, one-token shapes first", () => {
		const { shapes } = legacyDefinition()
		const formats = shapes.filter(({ id }) => id.startsWith("format."))
		const sorted = formats.map(({ id }) => id).toSorted()

		expect(formats.map(({ id }) => id)).toEqual(sorted)

		expect(formats.map(({ metadata }) => metadata.format)).toEqual(
			[...LEGACY_FORMATS].toSorted((left, right) => left.tokens - right.tokens).map(({ format }) => format)
		)
	})

	it("marks every PO box leader shape with the prefix the engine reads", () => {
		const { shapes } = legacyDefinition()
		const leaders = shapes.filter(({ id }) => id.startsWith("leader."))

		expect(leaders.map(({ id }) => id)).toEqual(["leader.en", "leader.fr", "leader.es"])
		expect(shapes.filter(({ id }) => !id.startsWith("format.") && !id.startsWith("leader."))).toEqual([])
	})

	it("equals the committed definition, so a change to the table needs a regenerated family", async () => {
		const committed = await readLocalJSONFile<unknown>(
			workspacePath("postcode", "data", "definitions", DEFINITION_FILE).toString()
		)

		expect(committed).toEqual(legacyDefinition())
	})
})
