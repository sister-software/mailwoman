// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer backfill gnis --state OH` — writes a Who's On First record into the
 *   `mailwoman` admin fork for each GNIS populated place in the `--state` states and territories
 *   that no WOF record covers (`@mailwoman/gazetteer/tools/pipeline/us/gnis-backfill`).
 *
 *   A territory's boundaries come from a polygon database passed with a second `--polygons`,
 *   such as one `gazetteer build census-polygons` built.
 *
 *   It reads the places `mailwoman corpus fetch usgs-gnis` wrote.
 *   The records take effect at the next `gazetteer build admin`, and `gazetteer doctor`
 *   checks their parent references.
 */

import { allKeyed } from "@mailwoman/core/async/promises"
import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "gnis",
	description: "Write a WOF record into the admin fork for each GNIS populated place no WOF record covers.",
	options: {
		state: { type: "string", multiple: true, required: true, description: "USPS state code to backfill, repeatable" },
		places: { type: "string", description: "GNIS places JSONL. Default: the latest `corpus fetch usgs-gnis` output" },
		admin: { type: "string", description: "Admin gazetteer. Default: the live admin-global-priority.db" },
		polygons: {
			type: "string",
			multiple: true,
			description:
				"Polygon database keyed by WOF id, repeatable; the first holding a place wins. Default: wof-polygons-us-full.db",
		},
		data: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		"dry-run": { type: "boolean", default: false, description: "Report the records and write no file" },
	},
} as const satisfies CommandSpec

interface Options {
	state: string[]
	places?: string
	admin?: string
	polygons?: string[]
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
			gazetteer: { CensusGazetteerKind, fetchCensusGazetteer, readCensusGazetteer },
		} = await allKeyed({
			backfill: import("@mailwoman/gazetteer/tools/pipeline/us/gnis-backfill"),
			dataRoot: import("@mailwoman/core/data-root"),
			paths: import("@mailwoman/resolver-wof-sqlite/paths"),
			gnis: import("@mailwoman/corpus/us/tools/fetch/usgs/gnis"),
			gazetteer: import("@mailwoman/tiger/sdk/gazetteer"),
		})

		const placesPath = options.places ?? currentSourcePath(USGS_GNIS_SLUG, USGS_GNIS_PLACES_FILENAME)
		const census = []

		for (const kind of Object.values(CensusGazetteerKind)) {
			census.push(...(await Array.fromAsync(readCensusGazetteer(await fetchCensusGazetteer(kind), kind))))
		}

		return backfillGNISPlaces({
			places: await readGNISPlaces(placesPath),
			census,
			states: options.state,
			adminPath: options.admin ?? wofDatabasePath("admin-global-priority.db"),
			polygonPaths: options.polygons?.length ? options.polygons : [wofDatabasePath("wof-polygons-us-full.db")],
			reposRoot: options.data ?? wofReposPath,
			dryRun: options.dryRun,
		})
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	const { records, covered, coveredByCensus, alreadyWritten, withoutPoint, unlocated, boundaries } = state.result
	const byPlacetype = Object.groupBy(records, (record) => record.placetype)
	const byState = Object.groupBy(records, (record) => record.state)

	return (
		<Box flexDirection="column">
			{boundaries.map(({ country, placetype, located, withoutGeometry }) => (
				<Text key={`${country}:${placetype}`}>
					{country} {placetype}: {located} boundaries loaded, {withoutGeometry} without a boundary
				</Text>
			))}
			{options.dryRun
				? records.map((record) => (
						<Text key={record.gnisID}>
							{record.state} GNIS {record.gnisID} {record.name} → {record.placetype} of {record.parent.placetype}{" "}
							{record.parent.id} ({record.parent.name})
						</Text>
					))
				: null}
			<Text>
				{options.dryRun ? "would write" : "wrote"} per state:{" "}
				{Object.entries(byState)
					.map(([code, group]) => `${code} ${group?.length ?? 0}`)
					.join(", ")}
			</Text>
			<Text color="green">
				{options.dryRun ? "would write" : "wrote"} {records.length} records (
				{Object.entries(byPlacetype)
					.map(([placetype, group]) => `${group?.length ?? 0} ${placetype}`)
					.join(", ")}
				)
			</Text>
			<Text>
				{coveredByCensus} covered through their Census GEOID, {covered} covered by name, {alreadyWritten} already
				written, {withoutPoint} without a GNIS point, {unlocated.length} outside every county-equivalent boundary
			</Text>
			{Object.entries(Object.groupBy(unlocated, (place) => place.state)).map(([code, group]) => (
				<Text key={code}>
					{code} unlocated GNIS ids ({group?.length ?? 0}): {group?.map((place) => place.gnisID).join(", ")}
				</Text>
			))}
		</Box>
	)
}

export default GazetteerBackfillGNIS
