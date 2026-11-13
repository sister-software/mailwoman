// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer build structures` builds `structures.db` beside `poi.db` from every
 *   registered official list of public structures (`@mailwoman/corpus/structures/sources`).
 *
 *   Each source reads the input its own fetch command wrote under the cache root's `sources/`.
 */

import { currentSourcesRoot } from "@mailwoman/core/data-root"
import { formatFileSize } from "@mailwoman/core/fs/readers/stat"
import { repoRootPath } from "@mailwoman/core/paths"
import { allKeyed } from "@mailwoman/core/promises"
import { buildSHA as resolveBuildSHA } from "@mailwoman/gazetteer/tools/pipeline/stamp-manifest"
import { PathBuilder } from "path-ts"

import {
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "structures",
	description: "Build the structures layer from every registered official list of public structures",
	options: {
		out: { type: "string", description: "Output database (default: structures.db beside poi.db)" },
		"sources-root": {
			type: "string",
			description: "The root each source's fetch wrote under (default: the cache root's sources/)",
		},
	},
} as const satisfies CommandSpec

const GazetteerBuildStructures: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { build, layers, paths, registry } = await allKeyed({
			build: import("@mailwoman/gazetteer/tools/pipeline/structures/build"),
			layers: import("#geocode/session/layers"),
			paths: import("@mailwoman/resolver-wof-sqlite/paths"),
			registry: import("@mailwoman/corpus/structures/sources"),
		})

		const out = options.out ?? paths.poiDatabasePath(layers.STRUCTURES_DATABASE_FILE)
		const sourcesRoot = options.sourcesRoot ? PathBuilder.from(options.sourcesRoot) : currentSourcesRoot()

		const result = await build.buildStructureLayer({
			sources: registry.STRUCTURE_SOURCES,
			sourcesRoot,
			out,
			buildSHA: resolveBuildSHA(repoRootPath()),
			onProgress: (phase, message) => console.error(`  [${phase}] ${message}`),
		})

		return [
			`structures.db: ${result.out} (${await formatFileSize(result.out)})`,
			`${result.rows.toLocaleString()} rows · ${result.coverageCells.toLocaleString()} coverage cells`,
			...[...result.sources].flatMap(([id, counts]) => [
				`  ${id} @ ${counts.vintage}: ${counts.inputRecords.toLocaleString()} records, ` +
					`${counts.recordsWithoutPoint.toLocaleString()} without a point`,
				...Object.entries(counts.categories)
					.toSorted(([, a], [, b]) => b - a)
					.map(([category, rows]) => `    ${category}: ${rows.toLocaleString()}`),
			]),
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default GazetteerBuildStructures
