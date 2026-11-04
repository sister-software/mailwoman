// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Builds the corpus street index from one corpus version's premise-register rows.
 *   Usage:
 *     node packages/corpus/lib/tools/street-index/build.run.ts --manifest <MANIFEST.json> --out <street-index.db>
 *       [--duckdb-threads 8] [--duckdb-memory-gb 12]
 */

import { prettyJSON } from "@mailwoman/core/json"
import { integerArgument, parseArguments } from "@mailwoman/core/scripting/arguments"

import { buildStreetIndex } from "#tools/street-index/build"

const { values } = parseArguments({
	options: {
		manifest: { type: "string" },
		out: { type: "string" },
		"duckdb-threads": { type: "string", default: "8" },
		"duckdb-memory-gb": { type: "string", default: "12" },
	},
})

if (!values.manifest || !values.out) {
	throw new Error("street-index build: --manifest and --out are required")
}

const report = await buildStreetIndex({
	manifest: values.manifest,
	out: values.out,
	limits: {
		threads: integerArgument("duckdb-threads", values["duckdb-threads"]),
		memoryLimitBytes: integerArgument("duckdb-memory-gb", values["duckdb-memory-gb"]) * 1024 ** 3,
	},
})

console.log(prettyJSON(report))
