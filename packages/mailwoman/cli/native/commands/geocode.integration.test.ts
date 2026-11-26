// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file `geocode --stdin --workers 2` prints the records one worker prints, in input order, though its worker pool
 *   yields results in completion order.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { runFileSync } from "@mailwoman/core/scripting/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { TextSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

import { mailwomanCLIPath } from "#package/metadata"

const cliBin = await mailwomanCLIPath()

// Mixed countries and lengths, so a worker can finish a later line first.
// The empty line is skipped.
const ADDRESSES = [
	"350 5th Ave, New York, NY 10118",
	"38 Upper Belgrave Rd, Clifton, Bristol BS8 2XN",
	"",
	"90210",
	"3 Rue des Lyonnais, 75005 Paris, France",
	"Lakehead University, 955 Oliver Rd, Thunder Bay, ON P7B 5E1, Canada",
]

const geocodeStdin = (workers: number): Array<Record<string, unknown>> =>
	TextSpliterator.from(
		runFileSync("node", [cliBin, "geocode", "--stdin", "--json", "--workers", String(workers)], {
			input: ADDRESSES.join("\n"),
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 16 * 1024 * 1024,
		})
	)
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const { engine: _engine, ...result } = parseJSONStrict<Record<string, unknown>>(line)

			return result
		})
		.toArray()

describe.skipIf(!(await pathExists(cliBin)))("mailwoman geocode --stdin --workers", () => {
	test("two workers print one worker's records in input order", () => {
		const one = geocodeStdin(1)
		const two = geocodeStdin(2)

		expect(one.map((record) => record["input"])).toEqual(ADDRESSES.filter(Boolean))
		expect(two).toEqual(one)
	}, 300_000)
})
