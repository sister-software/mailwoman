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

import { allKeyed } from "@mailwoman/core/promises"

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
	name: "importance",
	description: "Build the importance database for an admin database",
	options: {
		admin: {
			type: "string",
			description: "Admin database to score. Default <data-root>/db/wof/admin-global-priority.db",
		},
		tsv: { type: "string", description: "Pre-downloaded Wikimedia importance data" },
	},
} as const satisfies CommandSpec

const GazetteerImportance: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const {
			importance: { buildImportance },
			defaults: { DEFAULT_ADMIN_DB },
			paths: { wofDatabasePath },
		} = await allKeyed({
			importance: import("@mailwoman/gazetteer/tools/pipeline/importance"),
			defaults: import("@mailwoman/gazetteer/tools/pipeline/defaults"),
			paths: import("@mailwoman/resolver-wof-sqlite/paths"),
		})

		const t0 = performance.now()

		const r = await buildImportance({
			adminDB: options.admin ?? wofDatabasePath(DEFAULT_ADMIN_DB),
			tsv: options.tsv,
			onProgress: (message) => console.error(`  ${message}`),
		})

		const elapsed = ((performance.now() - t0) / 1000).toFixed(1)

		return [
			`importance: ${r.out}  (${elapsed}s)`,
			`admin md5: ${r.admin.md5}`,
			`Encyclopedic (Wikipedia): ${r.encyclopedic} places`,
			`Referential only (no article): ${r.referentialOnly} places`,
			`Total in place_importance: ${r.total} places`,
			`Fan-out guard: ${r.fanout.droppedPlaces} places dropped from ${r.fanout.unresolvableGroups + r.fanout.populationGroups} ambiguous Wikidata ids (#1497)`,
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default GazetteerImportance
