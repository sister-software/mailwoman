// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { libpostalLineSurfaces } from "#resources/libpostal"

describe("libpostalLineSurfaces", () => {
	it("splits a dictionary line into its pipe-separated surfaces", () => {
		expect(libpostalLineSurfaces("between|betw|btwn")).toEqual(["between", "betw", "btwn"])
	})
})
