// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the post-office parse suite from the post offices of every registered structure source.
 *
 *   Usage: node packages/mailwoman/tools/eval-harness/post-offices/build.run.ts
 *   --out <directory> [--sources-root <root>]
 *
 *   Each source reads the input its fetch command wrote under the cache root's `sources/`.
 *   The suite's manifest, rows and lineage are written under `--out`.
 */

import { currentSourcesRoot } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { STRUCTURE_SOURCES } from "@mailwoman/corpus/structures/sources"
import { PathBuilder } from "path-ts"

import { buildPostOfficeSuite } from "#tools/eval-harness/post-offices/build"

const { values } = parseArguments({
	options: {
		out: { type: "string", description: "The directory the suite is written to" },
		"sources-root": {
			type: "string",
			description: "The root each source's fetch wrote under (default: the cache root's sources/)",
		},
	},
})

if (!values.out) throw new Error("--out <directory> is required")

const built = await buildPostOfficeSuite({
	sources: STRUCTURE_SOURCES,
	sourcesRoot: values["sources-root"] ? PathBuilder.from(values["sources-root"]) : currentSourcesRoot(),
	outDirectory: values.out,
	createdAt: new Date().toISOString(),
})

console.log(`${built.manifestPath}: ${built.rows.length.toLocaleString("en-US")} rows`)

for (const source of built.sources) {
	console.log(`  ${source.id} @ ${source.vintage}: ${stringifyJSON(source.tally)}`)
}
