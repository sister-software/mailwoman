// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer build streets` — the street table, merged streets and their
 *   crossings tied to the gazetteer's places, from a road network source.
 *   Sealed 0444.
 */

import { currentSourcePath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { allKeyed } from "@mailwoman/core/promises"
import type { StreetTableCounts } from "@mailwoman/gazetteer/tools/pipeline/streets"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, useStageProgress } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "streets",
	description: "Build the street table from OS Open Roads, the first road network source.",
	options: {
		out: { type: "string", description: "Output database. Default <data-root>/db/wof/streets-gb-os-open-roads.db" },
		input: {
			type: "string",
			description: "Directory of Open Roads GML. Default <cache-root>/sources/gb-os-open/open-roads/data",
		},
		boundaries: { type: "string", description: "Boundary file. Default <data-root>/db/wof/wof-polygons.db" },
	},
} as const satisfies CommandSpec

const GazetteerBuildStreets: CommandComponent<typeof spec> = ({ options }) => {
	const progress = useStageProgress<StreetTableCounts>({ describe: stringifyJSON })

	const state = useCommandTask(async () => {
		const {
			streets: { buildStreetTable },
			gbOsOpenRoads: { readOpenRoadsEdges },
			paths: { wofDatabasePath },
		} = await allKeyed({
			streets: import("@mailwoman/gazetteer/tools/pipeline/streets"),
			gbOsOpenRoads: import("@mailwoman/gazetteer/tools/pipeline/streets/gb-os-open-roads"),
			paths: import("@mailwoman/resolver-wof-sqlite/paths"),
		})

		const out = options.out ?? wofDatabasePath("streets-gb-os-open-roads.db")

		const counts = await buildStreetTable({
			edges: readOpenRoadsEdges(options.input ?? currentSourcePath("gb-os-open", "open-roads", "data")),
			// country-branch: OS Open Roads is Great Britain's road network,
			// and it's the one source this command reads.
			// A country taken from each road source's manifest would replace the literal.
			countries: ["GB"],
			boundariesPath: options.boundaries ?? wofDatabasePath("wof-polygons.db"),
			out,
			onProgress: progress.stage("streets"),
		})

		return `streets: ${stringifyJSON(counts)} → ${out} — sealed 0444`
	})

	return <CommandTaskResult state={state} progress={progress} />
}

export default GazetteerBuildStreets
