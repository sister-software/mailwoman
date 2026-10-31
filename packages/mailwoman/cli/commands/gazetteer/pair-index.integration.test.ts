/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `gazetteer pair-index` refuses a Great Britain tuple CSV. The only one it has read is HM Land
 *   Registry Price Paid Data. The license register refuses its address fields, so a GB build
 *   reads only the secondary sources. A `--source` for GB stops before opening any file.
 */

import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { describe, expect, test } from "vitest"

import { stripAnsi } from "#cli-kit"
import { mailwomanCLIPath } from "#metadata"

const cliBin = await mailwomanCLIPath()

describe("mailwoman gazetteer pair-index --country gb --source <csv>", () => {
	test("refuses the tuple CSV and writes no index", async () => {
		const run = runFile(
			process.execPath,
			[
				cliBin,
				"gazetteer",
				"pair-index",
				"--country",
				"gb",
				"--source",
				"ppd/2026-07-22/gb-tuples.csv",
				"--delta",
				"10",
				"--out",
				"never-written",
			],
			{ env: childEnv({ MAILWOMAN_TEST_MODE: "1" }) }
		)

		const failure: unknown = await run.then(
			() => null,
			(error: unknown) => error
		)

		expect(failure).toBeInstanceOf(Error)

		const { stdout = "", stderr = "" } = failure as { stdout?: string; stderr?: string }
		const output = stripAnsi(`${stdout}\n${stderr}`).replaceAll(/\s+/g, " ")

		expect(output).toContain("a Great Britain build reads no tuple CSV")
	})
})
