// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer backfill gnis --state OH` — writes a Who's On First record into
 *   the `mailwoman` US admin fork for each GNIS populated place in the `--state` states
 *   that no WOF record covers (`@mailwoman/gazetteer/tools/pipeline/us/gnis-backfill`).
 *
 *   It reads the places `mailwoman corpus fetch usgs-gnis` wrote.
 *   The records take effect at the next `gazetteer build admin`, and `gazetteer doctor`
 *   checks their parent references.
 */

import { allKeyed } from "@mailwoman/core/promises"
import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "gnis",
	description: "Write a WOF record into the US admin fork for each GNIS populated place no WOF record covers.",
	options: {
		state: { type: "string", multiple: true, required: true, description: "USPS state code to backfill, repeatable" },
		places: { type: "string", description: "GNIS places JSONL. Default: the latest `corpus fetch usgs-gnis` output" },
		admin: { type: "string", description: "Admin gazetteer. Default: the live admin-global-priority.db" },
		polygons: { type: "string", description: "US polygon database. Default: wof-polygons-us-full.db" },
		data: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		"dry-run": { type: "boolean", default: false, description: "Report the records and write no file" },
	},
} as const satisfies CommandSpec

interface Options {
	state: string[]
	places?: string
	admin?: string
	polygons?: string
	data?: string
	dryRun: boolean
}

const GazetteerBackfillGNIS: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const {
			backfill: { backfillGNISPlaces, readGNISPlaces },
			dataRoot: { currentSourcePath, wofReposPath },
			paths: { wofDatabasePath },
			gnis: { USGS_GNIS_PLACES_FILENAME, USGS_GNIS_SLUG },
		} = await allKeyed({
			backfill: import("@mailwoman/gazetteer/tools/pipeline/us/gnis-backfill"),
			dataRoot: import("@mailwoman/core/data-root"),
			paths: import("@mailwoman/resolver-wof-sqlite/paths"),
			gnis: import("@mailwoman/corpus/us/tools/fetch/usgs-gnis"),
		})

		const placesPath = options.places ?? currentSourcePath(USGS_GNIS_SLUG, USGS_GNIS_PLACES_FILENAME)

		return backfillGNISPlaces({
			places: await readGNISPlaces(placesPath),
			states: options.state,
			adminPath: options.admin ?? wofDatabasePath("admin-global-priority.db"),
			polygonPath: options.polygons ?? wofDatabasePath("wof-polygons-us-full.db"),
			reposRoot: options.data ?? wofReposPath,
			dryRun: options.dryRun,
		})
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	const { records, covered, alreadyWritten, withoutPoint, unlocated } = state.result
	const byPlacetype = Object.groupBy(records, (record) => record.placetype)

	return (
		<Box flexDirection="column">
			<Text color="green">
				{options.dryRun ? "would write" : "wrote"} {records.length} records (
				{Object.entries(byPlacetype)
					.map(([placetype, group]) => `${group?.length ?? 0} ${placetype}`)
					.join(", ")}
				)
			</Text>
			<Text>
				{covered} covered by a WOF record, {alreadyWritten} already written, {withoutPoint} without a GNIS point,{" "}
				{unlocated.length} outside every county boundary
			</Text>
			{unlocated.length ? <Text>unlocated GNIS ids: {unlocated.join(", ")}</Text> : null}
		</Box>
	)
}

export default GazetteerBackfillGNIS
