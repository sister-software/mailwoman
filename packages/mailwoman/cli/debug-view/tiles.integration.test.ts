// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { resolveTilesPath } from "#cli/debug-view/tiles"

describe("resolveTilesPath", () => {
	it("prefers the explicit flag", async () => {
		await expect(resolveTilesPath("/somewhere/planet.pmtiles")).resolves.toBe("/somewhere/planet.pmtiles")
	})
})
