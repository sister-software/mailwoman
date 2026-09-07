/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The releases manifest's wire keys are read in one place, `normalizeReleasesManifest`; a docs consumer that reads a
 *   raw legacy spelling past that boundary would silently turn a release's gazetteer off. The normalizer's own contract
 *   is pinned beside it in `mailwoman`; this pins the site's consumers.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, test } from "vitest"

describe("no docs consumer reads raw legacy wire keys outside the boundary", () => {
	for (const rel of ["src/pages/demo/_runtime.ts", "src/contexts/DemoEmbed.tsx"]) {
		test(`${rel} is house-cased only`, async () => {
			const src = await readLocalTextFile(resolvePackagePath("@mailwoman/docs", rel))

			expect(src).not.toContain("hasFst")
			expect(src).not.toContain("hasWofDb")
		})
	}
})
