// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer build` — the whole data pipeline, turnkey: `build admin`
 *   (WOF + Overture + GeoNames → verified, sealed admin gazetteer), then `importance` for
 *   that admin artifact, then `build candidate` (the byte-range candidate table) from both.
 *
 *   The admin build folds GeoNames into the admin database, and the candidate build reads it as built.
 *   Both artifacts land at staging/dated paths.
 *
 *   The operator swaps and promotes them as separate steps (releasing.md).
 */

import { formatFileSize } from "@mailwoman/core/fs/readers/stat"
import { allKeyed } from "@mailwoman/core/promises"

import {
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	type CommandComponent,
	phaseReporter,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "build",
	description: "Build the admin gazetteer, its importance database and the candidate gazetteer.",
	options: {
		data: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		"skip-verify": { type: "boolean", default: false, description: "Skip the admin verify check (development only)" },
	},
} as const satisfies CommandSpec

const GazetteerBuild: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const {
			pipeline: { buildAdmin, buildCandidate, DEFAULT_CANDIDATE_OUT, resolvePostcodeDatabases },
			paths: { wofDatabasePath },
			importanceBuild: { buildImportance },
		} = await allKeyed({
			pipeline: import("@mailwoman/gazetteer/tools/pipeline"),
			importanceBuild: import("@mailwoman/gazetteer/tools/pipeline/importance"),
			paths: import("@mailwoman/resolver-wof-sqlite/paths"),
		})

		console.error("▸ build admin (staging)")

		const admin = await buildAdmin({
			dataDir: options.data,
			skipVerify: options.skipVerify,
			onPhase: phaseReporter(),
		})

		// The candidate reads the importance build stamped with this admin database's md5, so it is built here.
		console.error(`▸ build importance ← ${admin.out}`)

		const importance = await buildImportance({
			adminDB: admin.out,
			onProgress: (message) => console.error(`  ${message}`),
		})

		const candidateOut = wofDatabasePath(DEFAULT_CANDIDATE_OUT)

		console.error(`▸ build candidate ← ${admin.out}`)

		const databases = await resolvePostcodeDatabases()

		const candidate = await buildCandidate({
			adminDB: admin.out,
			out: candidateOut,
			postcodeDatabases: databases,
			onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
		})

		return [
			`admin: ${admin.out} (${await formatFileSize(admin.out)}) — ${admin.verify ? "verify PASS" : "verify SKIPPED"}, sealed`,
			`importance: ${importance.out} (${importance.total.toLocaleString()} places), sealed`,
			`candidate: ${candidateOut} (${await formatFileSize(candidateOut)}) — ${candidate.rows.toLocaleString()} rows, sealed`,
			"next: mailwoman gazetteer verify --db <admin>, then swap + promote per RELEASING.md",
		]
	})

	// Progress streams to stderr, leaving stdout for the summary.
	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default GazetteerBuild
