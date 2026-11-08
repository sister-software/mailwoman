// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { APP_TITLE, pageTitle } from "#page-title"

test("a matched place leads the title, and a blank subject leaves the app's name", () => {
	expect(pageTitle("Chicago")).toBe(`Chicago · ${APP_TITLE}`)
	expect(pageTitle("  ")).toBe(APP_TITLE)
	expect(pageTitle(null)).toBe(APP_TITLE)
})
