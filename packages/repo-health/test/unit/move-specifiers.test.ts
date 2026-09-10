/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Replacement specifiers come from the package's own `imports`/`exports` patterns, in the family the author
 *   wrote. The manifest here reproduces `@mailwoman/corpus`: a `#*` wildcard whose `types` condition points into
 *   `out/`, and a `./recipes/*` export.
 */

import {
	packageSpecifiersFor,
	relativeSpecifier,
	specifierFamily,
	type PackageManifest,
} from "@mailwoman/repo-health/move/specifiers"
import { describe, expect, test } from "vitest"

const CORPUS: PackageManifest = {
	dir: "packages/corpus",
	name: "@mailwoman/corpus",
	imports: {
		"#test-kit/corpus-recipe": "./lib/test-kit/corpus-recipe.ts",
		"#*": { types: "./out/*.d.ts", node: "./lib/*.ts", default: "./out/*.js" },
	},
	exports: {
		".": { types: "./out/index.d.ts", node: "./lib/index.ts", default: "./out/index.js" },
		"./recipes/*": { types: "./out/recipes/*.d.ts", node: "./lib/recipes/*.ts", default: "./out/recipes/*.js" },
	},
}

describe("specifierFamily", () => {
	test("separates the three families a replacement must stay inside", () => {
		expect(specifierFamily("./sibling.ts")).toBe("relative")
		expect(specifierFamily("../parent.ts")).toBe("relative")
		expect(specifierFamily("#recipes/fr/order")).toBe("internal")
		expect(specifierFamily("@mailwoman/corpus/recipes/fr/order")).toBe("bare")
		expect(specifierFamily("node:path")).toBe("bare")
	})
})

describe("packageSpecifiersFor", () => {
	test("derives both families from the wildcard patterns", () => {
		expect(packageSpecifiersFor(CORPUS, "packages/corpus/lib/recipes/fr/order.ts")).toEqual({
			internal: ["#recipes/fr/order"],
			bare: ["@mailwoman/corpus/recipes/fr/order"],
		})
	})

	test("never mints the `#lib/…` form the language service proposed", () => {
		// `getEditsForFileRename` answered `#lib/recipes/fr-fragment` for a moved recipe. The `#*` pattern maps to
		// `./lib/*.ts`, so that specifier names `lib/lib/recipes/fr-fragment.ts` — a path no checkout has.
		const { internal } = packageSpecifiersFor(CORPUS, "packages/corpus/lib/recipes/fr-fragment.ts")

		expect(internal).toEqual(["#recipes/fr-fragment"])
		expect(internal).not.toContain("#lib/recipes/fr-fragment")
	})

	test("reads an exact map entry as well as a pattern", () => {
		const { internal } = packageSpecifiersFor(CORPUS, "packages/corpus/lib/test-kit/corpus-recipe.ts")

		expect(internal).toContain("#test-kit/corpus-recipe")
	})

	test("names the package itself for a root export target", () => {
		expect(packageSpecifiersFor(CORPUS, "packages/corpus/lib/index.ts").bare).toContain("@mailwoman/corpus")
	})

	test("answers nothing for a file outside the package", () => {
		expect(packageSpecifiersFor(CORPUS, "packages/core/lib/index.ts")).toEqual({ internal: [], bare: [] })
	})
})

describe("relativeSpecifier", () => {
	test("keeps the explicit extension the repository writes", () => {
		expect(
			relativeSpecifier("packages/corpus/lib/recipes/index.ts", "packages/corpus/lib/recipes/fr/order.ts", true)
		).toBe("./fr/order.ts")
	})

	test("drops the extension when the original specifier carried none", () => {
		expect(relativeSpecifier("packages/corpus/lib/recipes/fr/order.ts", "packages/corpus/lib/scaffold.ts", false)).toBe(
			"../../scaffold"
		)
	})
})
