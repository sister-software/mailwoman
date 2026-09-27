/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { analyzeReferenceDocument, type ReferenceSubsidiary } from "@mailwoman/filer/tools"
import { describe, expect, it } from "vitest"

interface ExpectedFixtures {
	fixtures: Record<string, { subsidiaries: ReferenceSubsidiary[] }>
}

const fixtureDirectory = resolvePackageDirectory("@mailwoman/filer")("test-fixtures", "edgar")
const expected = await readLocalJSONFile<ExpectedFixtures>(fixtureDirectory("expected.json"))

describe("Exhibit 21 reference oracle", () => {
	for (const [name, fixture] of Object.entries(expected.fixtures)) {
		it(`${name} independently derives the reviewed subsidiary list`, async () => {
			const result = await analyzeReferenceDocument(fixtureDirectory(name))

			expect(result.subsidiaries).toEqual(fixture.subsidiaries)
		})
	}
})
