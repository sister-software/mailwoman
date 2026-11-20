// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { DefaultMailwomanPaths } from "@mailwoman/core/env"
import { afterEach, expect, test, vi } from "vitest"

import { wofDatabasePath, wofExtractPaths } from "#paths"

afterEach(() => {
	vi.unstubAllEnvs()
})

test("wofDatabasePath and wofExtractPaths read MAILWOMAN_DATA_ROOT when a path is requested", () => {
	vi.stubEnv("MAILWOMAN_DATA_ROOT", "/custom/root")
	expect(wofExtractPaths()[0]).toBe("/custom/root/db/wof/admin-global-priority.db")
	expect(wofDatabasePath("candidate.db").toString()).toBe("/custom/root/db/wof/candidate.db")

	vi.stubEnv("MAILWOMAN_DATA_ROOT", DefaultMailwomanPaths.data)
	expect(wofDatabasePath("candidate.db").toString()).toBe(`${DefaultMailwomanPaths.data}/db/wof/candidate.db`)
})
