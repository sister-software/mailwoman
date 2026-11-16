// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer build candidate` — the byte-range candidate gazetteer
 *   (FTS5-trigram fuzzy index baked in), built from the admin database the admin
 *   build already folded GeoNames into.
 *
 *   Progress streams to stderr.
 *
 *   The final summary goes to stdout.
 *   See releasing.md Step 5.
 */

import { allKeyed } from "@mailwoman/core/promises"
import { formatPhaseTimings } from "@mailwoman/core/utils"
import { DEFAULT_CANDIDATE_OUT } from "@mailwoman/gazetteer/tools/pipeline/defaults"

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
	name: "candidate",
	description: "Build the byte-range gazetteer candidate database",
	options: {
		admin: { type: "string", description: "Admin source DB. Default <data-root>/db/wof/admin-global-priority.db" },
		out: { type: "string", description: "Candidate DB output. Default <data-root>/db/wof/candidate-global.db" },
		importance: {
			type: "string",
			description:
				"Importance build to read. Default: the one `gazetteer importance` wrote beside the admin DB, named for its md5. " +
				"Either way the build refuses an importance build stamped with another admin DB",
		},
		"skip-importance": { type: "boolean", default: false, description: "Build with an empty importance column" },
		"include-build-local": {
			type: "boolean",
			default: false,
			description:
				"Fold a database whose own layer_manifest records tier build-local, for a gazetteer built for local use. " +
				"Without it the build refuses such a fold and names it",
		},
	},
} as const satisfies CommandSpec

const GazetteerBuildCandidate: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const {
			dataRoot: { dataRootPath },
			pipeline: { buildCandidate, DEFAULT_ADMIN_DB, resolvePostcodeDatabases },
			paths: { wofDatabasePath },
		} = await allKeyed({
			dataRoot: import("@mailwoman/core/data-root"),
			pipeline: import("@mailwoman/gazetteer/tools/pipeline"),
			paths: import("@mailwoman/resolver-wof-sqlite/paths"),
		})

		const root = dataRootPath()
		const adminDB = options.admin ?? wofDatabasePath(DEFAULT_ADMIN_DB)
		const out = options.out ?? wofDatabasePath(DEFAULT_CANDIDATE_OUT)
		const databases = await resolvePostcodeDatabases(undefined, root)

		console.error(`▸ candidate build ← ${adminDB} (${databases.length} postcode databases; FTS baked in)`)

		if (options.skipImportance) {
			console.error("  importance: SKIPPED by --skip-importance — the column will be empty")
		}

		const r = await buildCandidate({
			adminDB,
			out,
			postcodeDatabases: databases,
			// Without `--importance` the build finds the importance build for this admin DB itself.
			importanceDB: options.skipImportance ? false : options.importance,
			includeBuildLocalFolds: options.includeBuildLocal,
			onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
		})

		return [
			`gazetteer: ${out}`,
			`${r.rows.toLocaleString()} rows — ${r.primaries.toLocaleString()} primary, ${r.aliases.toLocaleString()} alias, ${r.postcodes.toLocaleString()} postcode + ${r.postcodeAliases.toLocaleString()} postcode-alias (from ${r.places.toLocaleString()} places)`,
			`ancestors: ${r.ancestorRows.toLocaleString()} closure rows across ${r.ancestorPlaces.toLocaleString()} places; ${r.intervalPlaces.toLocaleString()} interval labels`,
			r.importanceScored === null
				? "importance: not joined (no score source) — the column is empty"
				: `importance: ${r.importanceScored.toLocaleString()} places scored, ${r.importanceFiltered?.toLocaleString() ?? 0} refused as a different same-name place`,
			`phases: ${formatPhaseTimings(r.phaseSeconds)}`,
			`next: mailwoman gazetteer promote   (then publish, or run gazetteer release for all of it)`,
		]
	})

	// Progress streams to stderr until the summary lands.
	// `CommandTaskResult` renders that summary.
	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default GazetteerBuildCandidate
