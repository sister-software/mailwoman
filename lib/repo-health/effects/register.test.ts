// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { diffEffects, formatEffectDifferences } from "#repo-health/effects/register"

const READ = "read: readLocalTextFile → repo:config/release.json ×1"
const FETCH = "network: fetch → unresolved (identifier) ×1"

test("lists the effect lines a change adds and removes, by module, and leaves out an unchanged module", () => {
	const base = new Map([
		["packages/api/lib/app.ts", [READ]],
		["packages/core/lib/env.ts", [READ]],
		["packages/osm/lib/source.ts", [FETCH]],
	])

	const head = new Map([
		["packages/api/lib/app.ts", [READ, FETCH]],
		["packages/core/lib/env.ts", [READ]],
		["packages/ban/lib/source.ts", [FETCH]],
	])

	expect(diffEffects(base, head)).toEqual([
		{ file: "packages/api/lib/app.ts", added: [FETCH], removed: [] },
		{ file: "packages/ban/lib/source.ts", added: [FETCH], removed: [] },
		{ file: "packages/osm/lib/source.ts", added: [], removed: [FETCH] },
	])
})

test("a call count that changes reads as one line removed and one added", () => {
	const twice = READ.replace("×1", "×2")

	expect(diffEffects(new Map([["lib/a.ts", [READ]]]), new Map([["lib/a.ts", [twice]]]))).toEqual([
		{ file: "lib/a.ts", added: [twice], removed: [READ] },
	])
})

test("formats a difference for a job summary, and states a change with zero effect changes", () => {
	expect(formatEffectDifferences([{ file: "lib/a.ts", added: [FETCH], removed: [READ] }])).toBe(
		["## Effect changes", "", "### `lib/a.ts`", "", `- added: \`${FETCH}\``, `- removed: \`${READ}\``, "", ""].join(
			"\n"
		)
	)

	expect(formatEffectDifferences([])).toContain("adds and removes zero effects")
})
