// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { substituteReleaseTokens } from "./remark.ts"

describe("substituteReleaseTokens", () => {
	test("replaces every token and leaves other braces alone", () => {
		const text = "npm install mailwoman@{{release.version}} @mailwoman/neural@{{ release.version }} ${{ github.ref }}"

		expect(substituteReleaseTokens(text, { version: "11.1.0" })).toBe(
			"npm install mailwoman@11.1.0 @mailwoman/neural@11.1.0 ${{ github.ref }}"
		)
	})

	test("throws on a key the release values don't define", () => {
		expect(() => substituteReleaseTokens("{{release.major}}", { version: "11.1.0" }, "start.mdx")).toThrow(
			"start.mdx: {{release.major}} refers to no release value. Known keys: version"
		)
	})
})
