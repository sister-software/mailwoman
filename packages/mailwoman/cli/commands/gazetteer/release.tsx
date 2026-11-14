// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { allKeyed } from "@mailwoman/core/promises"
import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, phaseReporter, useCommandTask } from "#cli-kit"

/**
 * Command specification for `gazetteer release`.
 *
 * It builds the candidate database from the admin database, promotes it and publishes it to R2.
 *
 * The publish step reads R2 credentials from the `RCLONE_S3_PUBLIC_*` environment variables.
 */
export const spec = {
	name: "release",
	description: "Build, promote, and publish a gazetteer release",
	options: {
		admin: { type: "string", description: "Admin source DB. Default <data-root>/db/wof/admin-global-priority.db" },
		out: { type: "string", description: "Candidate-DB output. Default <data-root>/db/wof/candidate-global.db" },
		promote: { type: "boolean", default: true, description: "Promote the convention path after building" },
		publish: { type: "boolean", default: true, description: "Publish to R2 and bump the demo after promoting" },
		"gazetteer-version": { type: "string", description: "Gazetteer version. Default today's date + 'a'" },
		"dry-run": { type: "boolean", default: false, description: "Preview the R2 upload; don't push or bump the demo" },
		"include-build-local": {
			type: "boolean",
			default: false,
			description:
				"Fold a database whose own layer_manifest records tier build-local. The publish step then refuses " +
				"the result unless --override-refusals is passed as well",
		},
		"override-refusals": {
			type: "boolean",
			default: false,
			description: "Publish over every refusal the candidate's own layer_manifest raises, printing each one",
		},
	},
} as const satisfies CommandSpec

const GazetteerRelease: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const {
			dataRoot: { dataRootPath },
			paths: { repoRootPathBuilder },
			pipeline: {
				buildCandidate,
				DEFAULT_ADMIN_DB,
				DEFAULT_CANDIDATE_OUT,
				defaultGazetteerVersion,
				promoteCandidate,
				publishGazetteer,
				resolvePostcodeDatabases,
			},
			paths2: { wofDatabasePath },
		} = await allKeyed({
			dataRoot: import("@mailwoman/core/data-root"),
			paths: import("@mailwoman/core/paths"),
			pipeline: import("@mailwoman/gazetteer/tools/pipeline"),
			paths2: import("@mailwoman/resolver-wof-sqlite/paths"),
		})

		const root = dataRootPath()
		const adminDB = options.admin ?? wofDatabasePath(DEFAULT_ADMIN_DB)
		const out = options.out ?? wofDatabasePath(DEFAULT_CANDIDATE_OUT)
		const lines: string[] = []

		const databases = await resolvePostcodeDatabases(undefined, root)

		console.error(`▸ build ← ${adminDB} (${databases.length} postcode databases; FTS baked in)`)

		const r = await buildCandidate({
			adminDB,
			out,
			postcodeDatabases: databases,
			includeBuildLocalFolds: options.includeBuildLocal,
			onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
		})

		lines.push(`built ${out} — ${r.rows.toLocaleString()} rows, ${r.postcodes.toLocaleString()} postcodes`)

		if (options.promote) {
			const linkPath = await promoteCandidate(out, root)
			lines.push(`promoted ${linkPath} → ${out}`)
		}

		if (options.publish) {
			const version = options.gazetteerVersion ?? defaultGazetteerVersion(new Date())
			await using stage = await temporaryDirectory("mailwoman-gazetteer-")

			console.error(`▸ publish → R2 gazetteer/${version}/candidate.db${options.dryRun ? " (dry-run)" : ""}`)

			const p = await publishGazetteer({
				candidateDB: out,
				version,
				resourcesFile: repoRootPathBuilder("docs", "src", "shared", "resources.tsx"),
				stageDir: stage.path,
				prefix: "mailwoman",
				dryRun: options.dryRun,
				overrideRefusals: options.overrideRefusals,
				onPhase: phaseReporter(),
			})

			lines.push(`published R2 ${p.key}${p.bumped ? ` + demo → ${version} (commit resources.tsx)` : ""}`)
		}

		return lines
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				<Text color="green">✓ gazetteer release complete</Text>
				{state.result.map((line, i) => (
					<Text key={i}> • {line}</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerRelease
