// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer importance` — build the importance database for an admin database.
 *
 *   The build writes a sealed copy of the admin database with `place_importance` added
 *   and the admin file's md5 stamped into `importance_source`, beside the admin
 *   database under a name derived from that md5.
 *   `mailwoman gazetteer build candidate` finds it there.
 *
 *   `@mailwoman/gazetteer/tools/pipeline/importance` holds the build.
 *
 *   Run `mailwoman gazetteer build admin` first.
 */

import { allKeyed } from "@mailwoman/core/async/promises"

import {
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
	useStageProgress,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "importance",
	description: "Build the importance database for an admin database",
	options: {
		admin: {
			type: "string",
			description: "Admin database to score. Default <data-root>/db/wof/admin-global-priority.db",
		},
		tsv: { type: "string", description: "Pre-downloaded Wikimedia importance data" },
		"sub-locality-estimates": {
			type: "boolean",
			default: false,
			description:
				"Also write place_population_estimate: a population for each sub-locality with none, " +
				"its containing settlement's divided among that settlement's children",
		},
		out: {
			type: "string",
			description:
				"Write the importance database here instead of beside the admin DB. " +
				"Pass the same path to `gazetteer build candidate --importance`",
		},
	},
} as const satisfies CommandSpec

const GazetteerImportance: CommandComponent<typeof spec> = ({ options }) => {
	const progress = useStageProgress()

	const state = useCommandTask(async () => {
		const {
			importance: { buildImportance },
			defaults: { DEFAULT_ADMIN_DB },
			paths: { wofDatabasePath },
		} = await allKeyed({
			importance: import("@mailwoman/gazetteer/tools/pipeline/importance"),
			defaults: import("@mailwoman/gazetteer/tools/pipeline/recipe/defaults"),
			paths: import("@mailwoman/resolver-wof-sqlite/paths"),
		})

		const t0 = performance.now()

		const r = await buildImportance({
			adminDB: options.admin ?? wofDatabasePath(DEFAULT_ADMIN_DB),
			tsv: options.tsv,
			subLocalityEstimates: options.subLocalityEstimates,
			out: options.out,
			onProgress: progress.stage("importance"),
		})

		const estimates = r.subLocality
			? [
					`Sub-locality estimates: ${r.subLocality.stats.estimated} of ${r.subLocality.stats.subLocalities} sub-localities` +
						(r.subLocality.calibration
							? `, rank factor ${r.subLocality.calibration.rankFactor.toFixed(4)} from ${r.subLocality.calibration.compared} measured`
							: ", none written: no measured sub-locality to calibrate against"),
				]
			: []

		const elapsed = ((performance.now() - t0) / 1000).toFixed(1)

		return [
			`importance: ${r.out}  (${elapsed}s)`,
			`admin md5: ${r.admin.md5}`,
			`Encyclopedic (Wikipedia): ${r.encyclopedic} places`,
			`Referential only (no article): ${r.referentialOnly} places`,
			`Total in place_importance: ${r.total} places`,
			`Fan-out guard: ${r.fanout.droppedPlaces} places dropped from ${r.fanout.unresolvableGroups + r.fanout.populationGroups} ambiguous Wikidata ids (#1497)`,
			...estimates,
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} progress={progress} />

	return <CommandSummaryLines lines={state.result} />
}

export default GazetteerImportance
