// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Downloads the GEBCO undersea gazetteer and builds the sealed layer database and Earth's browser asset.
 *
 *   Usage: `node packages/undersea/tools/build.run.ts [--source <download dir>] [--out <db path>]`.
 *   Without `--source`, the run reads the service and keeps the download under
 *   `$MAILWOMAN_DATA_ROOT/src/undersea/<date>/`.
 */

import { gitHead } from "@mailwoman/core/git"
import { prettyJSON } from "@mailwoman/core/json"
import { scriptBuildCommand } from "@mailwoman/core/layers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isoDate } from "@mailwoman/core/utils"
import { PathBuilder } from "path-ts"

import { underseaDatabasePath, underseaSourcePath } from "#paths"
import { downloadUnderseaGazetteer } from "#sdk/download"
import { readDepths } from "#tools/depth"
import { buildUnderseaLayer } from "#tools/undersea-layer"

const { values } = parseArguments({
	options: {
		source: { type: "string" },
		out: { type: "string" },
		asset: { type: "string" },
	},
})

let sourceDirectory = values.source ? PathBuilder.from(values.source) : null

if (!sourceDirectory) {
	const sourceVintage = isoDate()

	sourceDirectory = underseaSourcePath(sourceVintage)

	await downloadUnderseaGazetteer(sourceDirectory, { sourceVintage, log: (line) => console.error(line) })
}

const result = await buildUnderseaLayer({
	sourceDirectory,
	out: values.out ?? underseaDatabasePath("undersea-gebco.db").toString(),
	assetOut: values.asset ?? underseaDatabasePath("undersea-features.geojson").toString(),
	createdAt: new Date().toISOString(),
	buildSHA: await gitHead(),
	buildCmd: scriptBuildCommand(import.meta.url),
	readDepths: (requests) => readDepths(requests, undefined, (line) => console.error(line)),
	log: (line) => console.error(line),
})

console.log(prettyJSON(result, false))
