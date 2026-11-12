// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { censusGroupOf, summarizeEffectEdges } from "#repo-health/effects/census"
import type { EffectEdge } from "#repo-health/effects/extract"

function edge(file: string, kind: EffectEdge["kind"], resolved: boolean): EffectEdge {
	return {
		file,
		line: 1,
		interface: "readLocalTextFile",
		kind,
		target: resolved ? { root: "repo", path: "x" } : null,
		unresolved: resolved ? null : "path",
		unresolvedShape: resolved ? null : "parameter",
	}
}

describe("the effect census", () => {
	it("assigns a path to its workspace, or to its first segment outside packages/", () => {
		expect(censusGroupOf("packages/core/lib/fs/readers.ts")).toBe("packages/core")
		expect(censusGroupOf("lib/repo-health/check.ts")).toBe("lib")
		expect(censusGroupOf("docs/plugins/a.ts")).toBe("docs")
	})

	it("counts resolved and unresolved edges per workspace and kind", () => {
		expect(
			summarizeEffectEdges([
				edge("packages/core/lib/a.ts", "read", true),
				edge("packages/core/lib/b.ts", "read", false),
				edge("packages/core/lib/b.ts", "write", false),
				edge("lib/x.ts", "read", true),
			])
		).toEqual([
			{ workspace: "lib", kind: "read", resolved: 1, unresolved: 0 },
			{ workspace: "packages/core", kind: "read", resolved: 1, unresolved: 1 },
			{ workspace: "packages/core", kind: "write", resolved: 0, unresolved: 1 },
		])
	})
})
