// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman eval poi-board --json` prints one JSON document.
 *
 *   The report holds query strings longer than a terminal line.
 *   A renderer that wraps them puts a line break inside a string value, and the output stops being JSON.
 */

// ci-runner: mailwoman-data

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { poiDatabasePath, wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, test } from "vitest"

import { mailwomanCLIPath } from "#metadata"

const cliBin = await mailwomanCLIPath()

const haveData = (await pathExists(poiDatabasePath("poi.db"))) && (await pathExists(wofDatabasePath("candidate.db")))

describe.skipIf(!haveData)("mailwoman eval poi-board --json", { timeout: 180_000 }, () => {
	test("prints a document a JSON parser accepts, with every case it graded", async () => {
		const { stdout } = await runFile("node", [cliBin, "eval", "poi-board", "--json"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 16 * 1024 * 1024,
		})

		const report = parseJSONStrict<{ totalCases: number; cases: unknown[] }>(stdout)

		expect(report.totalCases).toBeGreaterThan(0)
		expect(report.cases).toHaveLength(report.totalCases)
	})
})
