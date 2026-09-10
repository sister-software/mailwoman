/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The corpus recipe family-directory contract: repeated flat filename prefixes become directories.
 */

import { collectRepoContext } from "@mailwoman/repo-health"
import {
	findRepeatedRecipePrefixes,
	recipePrefixDirectoriesCheck,
} from "@mailwoman/repo-health/checks/recipe-prefix-directories"
import { describe, expect, test } from "vitest"

describe("recipe-prefix-directories", () => {
	test("groups only repeated direct recipe-file prefixes", () => {
		expect(
			findRepeatedRecipePrefixes([
				"packages/corpus/lib/recipes/fr-admin-split.ts",
				"packages/corpus/lib/recipes/fr-order.ts",
				"packages/corpus/lib/recipes/no-street.ts",
				"packages/corpus/lib/recipes/fr/fragment.ts",
				"packages/corpus/lib/recipes/index.ts",
			])
		).toEqual([
			{
				prefix: "fr",
				files: ["packages/corpus/lib/recipes/fr-admin-split.ts", "packages/corpus/lib/recipes/fr-order.ts"],
			},
		])
	})

	test("reports each repeated prefix with its directory destination", async () => {
		const diagnostics = await recipePrefixDirectoriesCheck.run({
			repoRoot: "/repo",
			trackedFiles: ["packages/corpus/lib/recipes/po-box.ts", "packages/corpus/lib/recipes/po-box-cedex.ts"],
		})

		expect(diagnostics).toEqual([
			expect.objectContaining({
				severity: "error",
				file: "packages/corpus/lib/recipes/po-box-cedex.ts",
				message: expect.stringContaining("packages/corpus/lib/recipes/po/"),
			}),
		])
	})

	test("reports nothing on the current tree", async () => {
		const context = await collectRepoContext()

		expect(await recipePrefixDirectoriesCheck.run(context)).toEqual([])
	})
})
