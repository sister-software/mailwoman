/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Wire-key contract for the published releases manifest (the batch-A casing incident). The
 *   acronym sweep capitalized `hasFst`/`hasWofDb` in code while the R2 releases.json kept the old
 *   keys — every release read `undefined`, silently disabling the demo's WOF cascade and FST from
 *   2026-07-01 to 07-04, with zero console errors. releases.json keys are a string contract
 *   (AGENTS.md wire-key exemption): the demo, the embed context, and the publisher must all use
 *   the published casing.
 */

import { readFileSync } from "node:fs"

import { describe, expect, test } from "vitest"

const SOURCES = [
	"./demo-helpers.ts",
	"../pages/demo/_app.tsx",
	"../contexts/DemoEmbed.tsx",
	"../../../scripts/publish-release-to-hf.ts",
] as const

describe("releases.json wire keys (string contract — exempt from the acronym convention)", () => {
	for (const rel of SOURCES) {
		test(`${rel} uses the published casing (hasFst / hasWofDb)`, () => {
			const src = readFileSync(new URL(rel, import.meta.url), "utf8")

			expect(src).not.toContain("hasFST")
			expect(src).not.toContain("hasWOFDb")
		})
	}
})
