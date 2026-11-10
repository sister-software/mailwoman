/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import ts from "typescript"
import { expect, it } from "vitest"

import { extractPathMentions } from "#repo-health/effects/mentions"

const FILE = "packages/postcode/lib/shapes.test.ts"

it("lists the outermost path each expression builds, and the literal prefix of a path it builds from a variable", () => {
	const text = `
		import { repoRootPath } from "@mailwoman/core/paths"
		import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
		import { relative, resolvePath } from "path-ts"

		const fixture = resolvePath(import.meta.dirname, "fixtures", "rows.json")
		check(repoRootPath())
		load(repoRootPath("packages", name, "data"))
		table(resolvePackagePath("@mailwoman/codex", "data", "tables.json"))
		ignore("/etc/hosts")
		label(relative(repoRootPath(), fixture))
	`

	const mentions = extractPathMentions(ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true), FILE)

	expect(mentions).toEqual([
		{ root: "repo", path: "packages/postcode/lib/fixtures/rows.json" },
		{ root: "repo", path: "" },
		{ root: "repo", path: "packages" },
		{ root: "package", path: "@mailwoman/codex/data/tables.json" },
	])
})
