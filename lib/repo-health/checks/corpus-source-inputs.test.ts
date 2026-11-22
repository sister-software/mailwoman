// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The corpus-source-inputs check over a planted adapter.
 *
 *   The check reads the committed source-inputs table and the address-source register of this repository whatever
 *   root its context states, so a fixture supplies only the adapters. The `RECIPE_SOURCES` and `CARRIED_SOURCES`
 *   spellings come from the imported `@mailwoman/corpus` module, and the committed table maps each of them.
 */

import { describe, expect, it } from "vitest"

import { corpusSourceInputsCheck } from "#repo-health/checks/corpus-source-inputs"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

const UNMAPPED = "fixture-unmapped-source"

describe("corpusSourceInputsCheck", () => {
	it("reports an adapter id the source-inputs table has no entry for", async () => {
		await using context = await plantFixtureRepository({
			"packages/corpus/lib/fixture/adapter.ts": `export const FIXTURE_ADAPTER_ID = "${UNMAPPED}"\n`,
		})

		const diagnostics = await corpusSourceInputsCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["packages/corpus/data/corpus-source-inputs.json"])
		expect(diagnostics[0]!.message).toContain(UNMAPPED)
	})

	it("accepts a tree whose adapters declare no source beyond the mapped ones", async () => {
		await using context = await plantFixtureRepository({
			"packages/corpus/lib/fixture/adapter.ts": "export const parseRow = (row: string) => row.split(',')\n",
		})

		await expect(corpusSourceInputsCheck.run(context)).resolves.toEqual([])
	})
})
