// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { currentSourcesRoot, snapshotSourcesRoot } from "@mailwoman/core/data-root"
import { describe, expect, it } from "vitest"

import { overtureStagingPath } from "./paths.ts"

describe("overtureStagingPath", () => {
	it("resolves outside the snapshot and current-source roots", () => {
		const derived = overtureStagingPath("2026-06-17.0", "overture-es.corpus.jsonl").toString()

		for (const downloads of [snapshotSourcesRoot(), currentSourcesRoot()]) {
			expect(derived.startsWith(`${downloads.toString()}/`)).toBe(false)
		}
	})

	it("refuses a release that is not one path segment", () => {
		expect(() => overtureStagingPath("../2026-06-17.0")).toThrow(/is not a vintage/u)
	})
})
