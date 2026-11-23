// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file `mailwoman situs address-points --oa-csv` on the compiled CLI, against a two-row OpenAddresses run.
 *
 *   The build reads the committed register. It elects `openaddresses:us/hi/honolulu` with no SPDX expression.
 *   Run `yarn compile` before this suite.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readLayerManifest } from "@mailwoman/core/layers"
import { runFile } from "@mailwoman/core/scripting/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"
import { isSealed } from "@mailwoman/sqlite/sealed/db"
import { describe, expect, test, vi } from "vitest"

import { mailwomanCLIPath } from "#package/metadata"
import { withCLISpawnLockAsync } from "#test-kit/cli-spawn-lock"

vi.setConfig({ testTimeout: 180_000 })

const cliBin = await mailwomanCLIPath()

describe("mailwoman situs address-points --oa-csv", () => {
	test("records the run's publisher and the mixed identifier, counts the run's rows, and seals the database", async () => {
		await using directory = await temporaryDirectory("mw-situs-oa-")
		const csv = directory.path("us__hi__honolulu.csv")
		const out = directory.path("address-points-us-hi.db")

		await writeLocalTextFile(
			[
				"LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH",
				"-157.8583,21.3069,1,KING ST,,HONOLULU,,HI,96813,,a1",
				"-157.8590,21.3075,3,KING ST,,HONOLULU,,HI,96813,,a2",
			].join("\n") + "\n",
			csv
		)

		const run = await withCLISpawnLockAsync(() =>
			runFile(
				process.execPath,
				[cliBin, "situs", "address-points", "--state", "HI", "--oa-csv", csv.toString(), "--out", out.toString()],
				{ env: childEnv({ NODE_NO_WARNINGS: "1" }), maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }
			)
		)

		expect(run.stdout).toContain("openaddresses:us/hi/honolulu")
		await expect(isSealed(out)).resolves.toBe(true)

		using db = await openBuiltClient(out)
		const manifest = await readLayerManifest(db)

		expect(manifest).toMatchObject({
			license: "LicenseRef-US-Mixed",
			source: "openaddresses",
			sourceVintage: "openaddresses-latest",
			sourceRecords: { "openaddresses:us/hi/honolulu": 2 },
		})

		expect(manifest.attribution).toBe("City & County of Honolulu GIS, Hawaii (openaddresses:us/hi/honolulu)")
		expect(manifest.attribution).not.toContain("Overture")
	})
})
