// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer build geoparquet` — the Who's On First clones, or the combined
 *   gazetteer's places, as GeoParquet: the input of the overlay tile build.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { WOFGeoParquetCounts } from "@mailwoman/gazetteer/tools/pipeline/geoparquet"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, useStageProgress } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "geoparquet",
	description: "Export Who's On First records or the combined gazetteer's places to GeoParquet.",
	options: {
		out: { type: "string", required: true, description: "Output directory. The export writes rowset=<rowset>/ here" },
		rowset: {
			type: "string",
			choices: ["wof", "gazetteer"],
			default: "wof",
			description: "wof reads the clones. gazetteer reads the admin database and a wof export's boundaries",
		},
		repos: { type: "string", description: "Directory of whosonfirst-data-* clones. Default the data root's clones" },
		admin: { type: "string", description: "Admin database of the gazetteer row set. Default the data root's" },
		countries: { type: "string", description: "Comma-separated lower-case country codes. Default every country" },
		postcodes: { type: "boolean", description: "With wof, also read each country's postcode repository." },
		"skip-overture": {
			type: "boolean",
			description: "With gazetteer, leave Overture unread. Overture places then have no boundary.",
		},
	},
} as const satisfies CommandSpec

/**
 * A stage's detail as text: the gazetteer export reports a phrase and the clone walk reports its counts.
 */
function describeProgress(detail: WOFGeoParquetCounts | string): string {
	return typeof detail === "string" ? detail : stringifyJSON(detail)
}

const GazetteerBuildGeoParquet: CommandComponent<typeof spec> = ({ options }) => {
	const progress = useStageProgress<WOFGeoParquetCounts | string>({ describe: describeProgress })

	const state = useCommandTask(async () => {
		const { exportGazetteerGeoParquet, exportWOFGeoParquet } =
			await import("@mailwoman/gazetteer/tools/pipeline/geoparquet")

		const countries = options.countries ? { countries: options.countries.split(",") } : {}

		const { out, counts } =
			options.rowset === "gazetteer"
				? await exportGazetteerGeoParquet({
						out: options.out,
						...countries,
						...(options.admin ? { adminPath: options.admin } : {}),
						skipOverture: options.skipOverture === true,
						onPhase: progress.report,
					})
				: await exportWOFGeoParquet({
						out: options.out,
						...countries,
						...(options.repos ? { reposDir: options.repos } : {}),
						postcodes: options.postcodes === true,
						onProgress: progress.stage("geoparquet"),
					})

		return `geoparquet ${options.rowset}: ${stringifyJSON(counts)} → ${out}`
	})

	return <CommandTaskResult state={state} progress={progress} />
}

export default GazetteerBuildGeoParquet
